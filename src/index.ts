import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { config } from "./config.js";
import { listCondaEnvs } from "./paths.js";

const app = express();
app.use(express.json());

// Stateless mode: each request gets a fresh server+transport pair, so there's
// no session state to manage across requests from potentially multiple clients.
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE are only meaningful for stateful (session-based) mode.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, scriptsBaseDir: config.scriptsBaseDir, condaEnvs: listCondaEnvs() });
});

app.listen(config.port, config.host, () => {
  console.log(`laptop-gpu-mcp listening on http://${config.host}:${config.port}/mcp`);
  console.log(`scripts base dir: ${config.scriptsBaseDir}`);
  console.log(`conda envs found: ${listCondaEnvs().join(", ") || "none"}`);
});
