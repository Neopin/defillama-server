import { createChartData } from "../emissions-adapters/utils/convertToChartData";
import { createRawSections } from "../emissions-adapters/utils/convertToRawData";
import { createCategoryData } from "../emissions-adapters/utils/categoryData";
import adapters from "./utils/imports/emissions_adapters";
import { ApiChartData, ChartSection, Protocol, SectionData } from "../emissions-adapters/types/adapters";
import { createFuturesData } from "../emissions-adapters/utils/futures";
import { storeR2JSONString, getR2 } from "./utils/r2";
import { wrapScheduledLambda } from "./utils/shared/wrap";
import protocols from "./protocols/data";
import { sluggifyString } from "./utils/sluggify";
import parentProtocols from "./protocols/parentProtocols";
import { PromisePool } from "@supercharge/promise-pool";
import { shuffleArray } from "./utils/shared/shuffleArray";
import { sendMessage } from "./utils/discord";

type Chart = { label: string; data: ApiChartData[] | undefined };

const prefix = "coingecko:";

function getCgId(token: string) {
  const idStart = token.indexOf(prefix);
  if (idStart == -1) return null;
  return token.substring(idStart + prefix.length);
}
function findPId(cgId: string | null) {
  if (!cgId) return;
  const parent = parentProtocols.find((p) => p.gecko_id == cgId);
  if (parent) return { parentProtocol: parent.id, name: parent.name, gecko_id: parent.gecko_id };
  return protocols.find((p) => p.gecko_id == cgId);
}

async function aggregateMetadata(
  protocolName: string,
  realTimeChart: Chart[],
  documentedChart: Chart[],
  rawData: SectionData,
  documentedData: ChartSection[],
  replaces: string[]
) {
  const pId = rawData.metadata.protocolIds?.[0] ?? null;
  const cgId = getCgId(rawData.metadata.token);
  const pData = pId && pId !== "" ? protocols.find((p) => p.id == pId) : findPId(cgId);
  const id = pData ? pData.parentProtocol || pData.name : cgId ? cgId : protocolName;

  const factories: string[] = ["daomaker"];
  if (factories.includes(protocolName) && !(pData || cgId))
    throw new Error(`no metadata for raw token ${rawData.metadata.token}`);

  let name = id;
  if (pData?.parentProtocol) {
    name = parentProtocols.find((p) => p.id === pData.parentProtocol)?.name ?? id;
  }

  const realTimeTokenAllocation = createCategoryData(realTimeChart, rawData.categories, false);
  const documentedTokenAllocation = createCategoryData(
    documentedChart,
    rawData.categories,
    false,
    documentedData,
    replaces
  );

  const futures = pData && "symbol" in pData ? await createFuturesData(pData.symbol) : undefined;

  return {
    data: {
      realTimeData: {
        data: realTimeChart,
        tokenAllocation: realTimeTokenAllocation,
      },
      documentedData: {
        data: documentedChart,
        tokenAllocation: documentedTokenAllocation,
      },
      metadata: rawData.metadata,
      name: name,
      gecko_id: pData?.gecko_id,
      futures,
    },
    id,
  };
}

async function processSingleProtocol(adapter: Protocol, protocolName: string): Promise<string> {
  const rawData = await createRawSections(adapter);

  const { realTimeData, documentedData } = await createChartData(protocolName, rawData, false);
  const realTimeChart: Chart[] = realTimeData.map((s: ChartSection) => ({
    label: s.section,
    data: s.data.apiData,
  }));

  const documentedChart: Chart[] = documentedData.map((s: ChartSection) => ({
    label: s.section,
    data: s.data.apiData,
  }));

  const { data, id } = await aggregateMetadata(
    protocolName,
    realTimeChart,
    documentedChart,
    rawData,
    documentedData,
    adapter.documented?.replaces ?? []
  );

  const sluggifiedId = sluggifyString(id).replace("parent#", "");

  await storeR2JSONString(`emissions/${sluggifiedId}`, JSON.stringify(data));
  console.log(protocolName);

  return sluggifiedId;
}

async function handler() {
  let protocolsArray: string[] = [];
  let protocolErrors: string[] = [];

  await PromisePool.withConcurrency(1)
    .for(shuffleArray(Object.entries(adapters)))
    .process(async ([protocolName, rawAdapter]) => {
      let adapters = typeof rawAdapter.default === "function" ? await rawAdapter.default() : rawAdapter.default;
      if (!adapters.length) adapters = [adapters];
      await Promise.all(
        adapters.map((adapter: Protocol) =>
          processSingleProtocol(adapter, protocolName)
            .then((p: string) => protocolsArray.push(p))
            .catch((err: Error) => {
              console.log(err.message, `: \n storing ${protocolName}`);
              protocolErrors.push(protocolName);
            })
        )
      );
    });

  await handlerErrors(protocolErrors);
  const res = await getR2(`emissionsProtocolsList`);
  if (res.body) protocolsArray = [...new Set([...protocolsArray, ...JSON.parse(res.body)])];
  await storeR2JSONString(`emissionsProtocolsList`, JSON.stringify(protocolsArray));
}

async function handlerErrors(errors: string[]) {
  if (errors.length > 0) {
    let errorMessage: string = `storeEmissions errors: \n`;
    errors.map((e: string) => (errorMessage += `${e}, `));
    process.env.UNLOCKS_WEBHOOK
      ? await sendMessage(errorMessage, process.env.UNLOCKS_WEBHOOK!)
      : console.log(errorMessage);
  }
}

export default wrapScheduledLambda(handler);
// handler(); // ts-node src/storeEmissions.ts
