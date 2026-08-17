import express, { Request, Response } from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.TODOIST_API_TOKEN;
if (!API_KEY) {
  console.error("Error: TODOIST_API_TOKEN is required");
  process.exit(1);
}

// Cliente HTTP nativo para Todoist API con soporte para API v1 y REST v2
async function todoistRequest(path: string, options: any = {}) {
  let url = `https://api.todoist.com/api/v1${path}`;
  let res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (res.status === 410 || res.status === 404) {
    url = `https://api.todoist.com/rest/v2${path}`;
    res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
  }

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Todoist API error ${res.status}: ${errorText}`);
  }

  if (res.status === 204) return null;
  return await res.json();
}

const TOOLS: Tool[] = [
  {
    name: "todoist_create_task",
    description: "Create a new task in Todoist with optional description, due date, and priority",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content/title of the task" },
        description: { type: "string", description: "Detailed description of the task (optional)" },
        due_string: { type: "string", description: "Natural language due date (optional)" },
        priority: { type: "number", description: "Priority 1-4 (optional)", enum: [1, 2, 3, 4] },
        project_id: { type: "string", description: "Project ID (optional)" }
      },
      required: ["content"]
    }
  },
  {
    name: "todoist_get_tasks",
    description: "Get a list of tasks from Todoist with various filters",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project ID (optional)" },
        filter: { type: "string", description: "Natural language filter (optional)" },
        priority: { type: "number", description: "Filter by priority 1-4 (optional)", enum: [1, 2, 3, 4] },
        limit: { type: "number", description: "Max tasks to return (optional)", default: 10 }
      }
    }
  },
  {
    name: "todoist_update_task",
    description: "Update an existing task in Todoist by searching for it by name",
    inputSchema: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "Name of the task to search and update" },
        content: { type: "string", description: "New title (optional)" },
        description: { type: "string", description: "New description (optional)" },
        due_string: { type: "string", description: "New due date (optional)" },
        priority: { type: "number", description: "New priority 1-4 (optional)", enum: [1, 2, 3, 4] }
      },
      required: ["task_name"]
    }
  },
  {
    name: "todoist_complete_task",
    description: "Complete a task in Todoist by searching for it by name or providing task ID",
    inputSchema: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "Name of the task to complete (optional)" },
        task_id: { type: "string", description: "ID of the task to complete (optional)" }
      }
    }
  },
  {
    name: "todoist_delete_task",
    description: "Delete a task in Todoist by searching for it by name or providing task ID",
    inputSchema: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "Name of the task to delete (optional)" },
        task_id: { type: "string", description: "ID of the task to delete (optional)" }
      }
    }
  }
];

async function executeTool(name: string, args: any) {
  console.log(`[EXEC] Tool: ${name}`, JSON.stringify(args));

  if (name === "todoist_create_task") {
    const { content, description, due_string, priority, project_id } = args || {};
    const task = await todoistRequest("/tasks", {
      method: "POST",
      body: JSON.stringify({
        content,
        description,
        due_string,
        priority,
        project_id,
      }),
    });
    return { content: [{ type: "text", text: `Task created: "${task.content}" (ID: ${task.id})` }] };
  }

  if (name === "todoist_get_tasks") {
    const { project_id, filter, priority, limit = 10 } = args || {};
    const params = new URLSearchParams();
    if (project_id) params.set("project_id", project_id);
    if (filter) params.set("filter", filter);
    const queryString = params.toString() ? `?${params.toString()}` : "";
    
    let tasks: any = await todoistRequest(`/tasks${queryString}`);
    if (Array.isArray(tasks) && priority) {
      tasks = tasks.filter((t: any) => t.priority === priority);
    }
    if (Array.isArray(tasks)) {
      tasks = tasks.slice(0, limit);
    }
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  }

  if (name === "todoist_update_task") {
    const { task_name, content, description, due_string, priority } = args || {};
    const tasks: any = await todoistRequest("/tasks");
    const task = Array.isArray(tasks) ? tasks.find((t: any) => t.content.toLowerCase().includes(task_name.toLowerCase())) : null;
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
    }
    const updated = await todoistRequest(`/tasks/${task.id}`, {
      method: "POST",
      body: JSON.stringify({ content, description, due_string, priority }),
    });
    return { content: [{ type: "text", text: `Task updated: "${updated.content}"` }] };
  }

  if (name === "todoist_complete_task") {
    const { task_name, task_id } = args || {};
    let targetId = task_id;
    if (!targetId && task_name) {
      const tasks: any = await todoistRequest("/tasks");
      const task = Array.isArray(tasks) ? tasks.find((t: any) => t.content.toLowerCase().includes(task_name.toLowerCase())) : null;
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
      }
      targetId = task.id;
    }
    await todoistRequest(`/tasks/${targetId}/close`, { method: "POST" });
    return { content: [{ type: "text", text: `Task ${targetId} completed.` }] };
  }

  if (name === "todoist_delete_task") {
    const { task_name, task_id } = args || {};
    let targetId = task_id;
    if (!targetId && task_name) {
      const tasks: any = await todoistRequest("/tasks");
      const task = Array.isArray(tasks) ? tasks.find((t: any) => t.content.toLowerCase().includes(task_name.toLowerCase())) : null;
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
      }
      targetId = task.id;
    }
    await todoistRequest(`/tasks/${targetId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Task ${targetId} deleted.` }] };
  }

  throw new Error(`Tool not found: ${name}`);
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "todoist-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.log("ListTools request recibido");
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      return await executeTool(name, args);
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message || String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: ["*"],
  exposedHeaders: ["*"]
}));

app.use(express.json());

const transports = new Map<string, SSEServerTransport>();

// Manejador SSE
const handleSse = async (req: Request, res: Response) => {
  console.log("Nueva conexión SSE entrante...");

  const transport = new SSEServerTransport("/message", res);
  const server = createMcpServer();

  transports.set(transport.sessionId, transport);
  console.log(`Sesión SSE iniciada: ${transport.sessionId}`);

  transport.onclose = () => {
    console.log(`Sesión SSE cerrada: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
};

// Rutas GET
app.get("/sse", handleSse);

app.get("/", (req: Request, res: Response) => {
  if (req.headers.accept?.includes("text/event-stream")) {
    return handleSse(req, res);
  }
  res.status(200).send("Todoist MCP Server is running!");
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "todoist-mcp-server" });
});

// Rutas POST (Soporta SSE Message y Streamable HTTP con fallback directo)
const handlePost = async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const body = req.body || {};

  console.log("Mensaje POST recibido:", { sessionId, method: body.method });

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    try {
      await transport.handlePostMessage(req, res, req.body);
      return;
    } catch (err) {
      console.warn("Error delegando a SSEServerTransport, procesando con fallback HTTP:", err);
    }
  }

  if (body.method === "initialize") {
    res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "todoist-mcp-server", version: "1.0.0" }
      }
    });
    return;
  }

  if (body.method === "notifications/initialized") {
    res.status(200).end();
    return;
  }

  if (body.method === "tools/list") {
    res.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (body.method === "tools/call") {
    try {
      const { name, arguments: args } = body.params || {};
      const result = await executeTool(name, args);
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result
      });
    } catch (err: any) {
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32603, message: err.message || String(err) }
      });
    }
    return;
  }

  if (body.method === "ping") {
    res.json({ jsonrpc: "2.0", id: body.id, result: {} });
    return;
  }

  res.status(200).json({ jsonrpc: "2.0", id: body.id, result: {} });
};

app.post("/", handlePost);
app.post("/sse", handlePost);
app.post("/message", handlePost);
app.post("/messages", handlePost);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Todoist MCP Server escuchando en el puerto ${PORT}`);
});
