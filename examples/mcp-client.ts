import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const url=process.env.LEDGER_MCP_URL,token=process.env.LEDGER_MCP_TOKEN;
if(!url||!token)throw new Error("Set LEDGER_MCP_URL and LEDGER_MCP_TOKEN");
const client=new Client({name:"personal-ledger-example",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`},redirect:"manual"}});
await client.connect(transport);console.log("server",client.getServerVersion());console.log("tools",(await client.listTools()).tools.map(tool=>tool.name));await transport.terminateSession();await client.close();
