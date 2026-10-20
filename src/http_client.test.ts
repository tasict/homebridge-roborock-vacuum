import * as http from "http";
import { AddressInfo } from "net";

const { createHttpClient } = require("../roborockLib/lib/httpClient");
const { createSignedApi } = require("../roborockLib/lib/roborockHome");

/** A local server that records each request and answers per the handler. */
async function startServer(
  handler: (
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse
  ) => void
) {
  const requests: {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("httpClient", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  afterEach(async () => {
    await server?.close();
  });

  it("joins the base URL, adds params and default headers, and parses JSON", async () => {
    server = await startServer((_req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 200, data: { rrHomeId: 7 } }));
    });
    const client = createHttpClient({
      baseURL: `${server.baseURL}/`,
      headers: { header_clientid: "abc" },
    });
    client.defaults.headers.common["Authorization"] = "token";

    const res = await client.get("/api/v1/getHomeDetail", {
      params: { country: "DE" },
      headers: { header_clientlang: "en" },
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ code: 200, data: { rrHomeId: 7 } });
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/v1/getHomeDetail?country=DE",
      headers: {
        header_clientid: "abc",
        header_clientlang: "en",
        authorization: "token",
      },
    });
  });

  it("posts a string as a URL-encoded form and keeps a non-JSON answer as text", async () => {
    server = await startServer((_req, _body, res) => res.end("ok"));
    const client = createHttpClient({ baseURL: server.baseURL });

    const res = await client.post(
      "api/v4/email/code/send",
      "type=login&email=a%40b.c"
    );

    expect(res.data).toBe("ok");
    expect(server.requests[0].body).toBe("type=login&email=a%40b.c");
    expect(server.requests[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
  });

  it("rejects a non-2xx answer with the response attached", async () => {
    server = await startServer((_req, _body, res) => {
      res.statusCode = 401;
      res.setHeader("Date", "Tue, 20 Oct 2026 10:00:00 GMT");
      res.end(JSON.stringify({ msg: "unauthorized" }));
    });
    const client = createHttpClient({ baseURL: server.baseURL });

    const error = await client
      .post("user/scene/1/execute")
      .catch((e: any) => e);

    expect(error.isRequestError).toBe(true);
    expect(error.response.status).toBe(401);
    expect(error.response.data).toEqual({ msg: "unauthorized" });
    expect(error.response.headers.date).toBe("Tue, 20 Oct 2026 10:00:00 GMT");
  });

  it("times out with an error that has no response", async () => {
    server = await startServer(() => undefined); // never answers
    const client = createHttpClient({ baseURL: server.baseURL, timeout: 100 });

    const error = await client.get("slow").catch((e: any) => e);

    expect(error.isRequestError).toBe(true);
    expect(error.response).toBeUndefined();
    expect(error.message).toBe("timeout of 100ms exceeded");
  });

  it("reports a refused connection as a request error without a response", async () => {
    server = await startServer(() => undefined);
    const { baseURL } = server;
    await server.close();
    const error = await createHttpClient({ baseURL })
      .get("x")
      .catch((e: any) => e);

    expect(error.isRequestError).toBe(true);
    expect(error.response).toBeUndefined();
  });

  it("signs cloud requests with a Hawk header over the request path", async () => {
    server = await startServer((_req, _body, res) => res.end("{}"));
    const api = createSignedApi({
      u: "user",
      s: "session",
      h: "hmac-secret",
      r: { a: server.baseURL },
    });

    await api.get("user/homes/42");

    expect(server.requests[0].headers.authorization).toMatch(
      /^Hawk id="user", s="session", ts="\d+", nonce="[^"]{6}", mac="[^"]+"$/
    );
  });
});
