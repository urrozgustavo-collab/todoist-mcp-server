import express, { Request, Response } from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TodoistApi } from "@doist/todoist-api-typescript";

const API_KEY = process.env.TODOIST_API_TOKEN;
if (!API_KEY) {
  console.error("Error: TODOIST_API_TOKEN is required");
  process.exit(1);
}

const todoistClient = new TodoistApi(API_KEY);

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
  if (name === "todoist_create_task") {
    const { content, description, due_string, priority, project_id } = args || {};
    const task = await todoistClient.addTask({
      content,
      description,
      dueString: due_string,
      priority,
      projectId: project_id,
    });
    return { content: [{ type: "text", text: `Task created: "${task.content}" (ID: ${task.id})` }] };
  }

  if (name === "todoist_get_tasks") {
    const { project_id, filter, priority, limit = 10 } = args || {};
    let tasks = await todoistClient.getTasks({ projectId: project_id, filter });
    if (priority) tasks = tasks.filter((t) => t.priority === priority);
    tasks = tasks.slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  }

  if (name === "todoist_update_task") {
    const { task_name, content, description, due_string, priority } = args || {};
    const tasks = await todoistClient.getTasks();
    const task = tasks.find((t) => t.content.toLowerCase().includes(task_name.toLowerCase()));
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
    }
    const updated = await todoistClient.updateTask(task.id, {
      content,
      description,
      dueString: due_string,
      priority,
    });
    return { content: [{ type: "text", text: `Task updated: "${updated.content}"` }] };
  }

  if (name === "todoist_complete_task") {
    const { task_name, task_id } = args || {};
    let targetId = task_id;
    if (!targetId && task_name) {
      const tasks = await todoistClient.getTasks();
      const task = tasks.find((t) => t.content.toLowerCase().includes(task_name.toLowerCase()));
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
      }
      targetId = task.id;
    }
    await todoistClient.closeTask(targetId);
    return { content: [{ type: "text", text: `Task ${targetId} completed.` }] };
  }

  if (name === "todoist_delete_task") {
    const { task_name, task_id } = args || {};
    let targetId = task_id;
    if (!targetId && task_name) {
      const tasks = await todoistClient.getTasks();
      const task = tasks.find((t) => t.content.toLowerCase().includes(task_name.toLowerCase()));
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_name}` }], isError: true };
      }
      targetId = task.id;
    }
    await todoistClient.deleteTask(targetId);
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
    console.log("ListTools request recibido (SSE)");
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      console.log(`CallTool request recibido (SSE): ${name}`, args);
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
  console.log("Nueva conexión SSE entrante desde:", req.ip, "User-Agent:", req.get("user-agent"));

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

// Rutas POST (Soporta SSE Message y Streamable HTTP directo)
const handlePost = async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (sessionId) {
    console.log(`Mensaje POST para sesión SSE: ${sessionId}`);
    const transport = transports.get(sessionId);
    if (!transport) {
      console.warn(`Sesión no encontrada: ${sessionId}`);
      res.status(404).send("Sesión no encontrada");
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
    return;
  }

  // Manejo directo de Streamable HTTP (JSON-RPC) si no hay sessionId
  const body = req.body || {};
  console.log("Mensaje POST Streamable HTTP recibido:", body.method, "id:", body.id);

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

  res.status(400).json({ error: "Unknown method or missing sessionId" });
};

app.post("/", handlePost);
app.post("/sse", handlePost);
app.post("/message", handlePost);
app.post("/messages", handlePost);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Todoist MCP Server escuchando en el puerto ${PORT}`);
});
