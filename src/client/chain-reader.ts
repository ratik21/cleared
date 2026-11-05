import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import {
  createPublicClient,
  fallback,
  type HttpTransportConfig,
  http,
  type PublicClient,
} from "viem";
import { RPC_BACKUP, whitechainSepolia } from "@/chain/whitechain";

/** tor-js specifier on Ethereum mainnet, from the anon-rpc adopters list. */
const TOR_SPECIFIER = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
const TOR_GATEWAYS = [
  "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ",
];
/** The one disclosed direct read: resolving the specifier, before Tor exists. */
const BOOTSTRAP_RPC = "https://ethereum-rpc.publicnode.com";

export interface ReadMeter {
  direct: number;
  private: number;
}

interface RpcRequest {
  method: string;
  params?: unknown;
}

const bootstrapProvider = {
  request: async ({ method, params }: RpcRequest) => {
    const response = await fetch(BOOTSTRAP_RPC, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { result, error } = await response.json();
    if (error) {
      throw new Error(error.message);
    }
    return result;
  },
};

export interface ChainReader {
  anonFetch: AnonRpcWorker["fetch"];
  client: PublicClient;
  meter: ReadMeter;
  ready: Promise<unknown>;
}

let reader: ChainReader | undefined;

/** The only way to create a chain client in the browser. One long-lived worker per page load. */
export const getChainReader = (): ChainReader => {
  if (reader) {
    return reader;
  }
  const worker = new AnonRpcWorker({
    address: TOR_SPECIFIER,
    config: { gateways: TOR_GATEWAYS },
    preExisting: { rpcProvider: bootstrapProvider },
  });
  const meter: ReadMeter = { direct: 0, private: 0 };
  const fetchFn: HttpTransportConfig["fetchFn"] = (input, init) => {
    meter.private += 1;
    return worker.fetch(input, init);
  };
  const client = createPublicClient({
    chain: whitechainSepolia,
    transport: fallback([
      http(whitechainSepolia.rpcUrls.default.http[0], { fetchFn }),
      http(RPC_BACKUP, { fetchFn }),
    ]),
  });
  reader = { anonFetch: worker.fetch, client, meter, ready: worker.ready };
  return reader;
};
