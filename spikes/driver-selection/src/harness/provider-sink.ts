import { createServer, type Server } from "node:http";

export interface ProviderSink {
  url: string;
  requestCount(): number;
  close(): Promise<void>;
}

export async function startProviderSink(): Promise<ProviderSink> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { type: "authentication_error", message: "A-layer sink" } }),
    );
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Provider sink did not expose a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
