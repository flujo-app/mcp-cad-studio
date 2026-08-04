import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const widget = await readFile(new URL("../dist/widget.html", import.meta.url), "utf8");
const boxMesh = {
  positions: [-20,-15,-9,20,-15,-9,20,15,-9,-20,15,-9,-20,-15,9,20,-15,9,20,15,9,-20,15,9],
  triangles: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
  bounds: { min: [-20,-15,-9], max: [20,15,9] },
  volume: 21600,
  surfaceArea: 4080,
  vertexCount: 8,
  triangleCount: 12,
};

const host = `<!doctype html><html><head><meta charset="utf-8"><title>CAD Studio preview host</title>
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#0c0f14;overflow:hidden}</style></head>
<body><iframe id="app" src="/widget"></iframe><script>
let revision=1;
let model={id:"11111111-1111-4111-8111-111111111111",name:"Starter block",color:"#6ee7b7",revision,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),kind:"box",shape:{kind:"box",size:[40,30,18],center:true}};
let models=[summary(model)];
const mesh=${JSON.stringify(boxMesh)};
function summary(value){return {id:value.id,name:value.name,color:value.color,revision:value.revision,updatedAt:value.updatedAt,kind:value.shape.kind};}
function payload(){return {models,activeModel:model,mesh};}
function result(structuredContent,text="OK"){return {content:[{type:"text",text}],structuredContent};}
function call(name,args){
 if(name==="list_models") return result({models});
 if(name==="load_model") return result(payload());
 if(name==="create_model"||name==="generate_model"){
  revision=1; const kind=name==="generate_model"?args.template:args.shape.kind;
  model={id:crypto.randomUUID(),name:args.name,color:args.color,revision,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),kind,shape:args.shape||{kind:"union",children:[{kind:"box",size:[40,30,18]},{kind:"box",size:[18,40,30]}]}};
  models=[summary(model),...models]; return result(payload());
 }
 if(name==="update_model"||name==="transform_model"){
  revision+=1; model={...model,name:args.name||model.name,color:args.color||model.color,shape:args.shape||model.shape,revision,updatedAt:new Date().toISOString()};
  models=models.map(m=>m.id===model.id?summary(model):m); return result(payload());
 }
 if(name==="duplicate_model"){
  model={...model,id:crypto.randomUUID(),name:model.name+" copy",revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; models=[summary(model),...models]; return result(payload());
 }
 if(name==="delete_model"){models=models.filter(m=>m.id!==model.id); model=models[0]?{...model,...models[0]}:null; return result({models,activeModel:null,mesh:null});}
 if(name==="export_model") return result({filename:"preview."+args.format,data:"# preview export",format:args.format});
 return result(payload());
}
addEventListener("message",event=>{
 const message=event.data; if(!message||message.jsonrpc!=="2.0"||message.id===undefined)return;
 let response;
 if(message.method==="ui/initialize") response={protocolVersion:"2026-01-26",hostInfo:{name:"preview-host",version:"1"},hostCapabilities:{},hostContext:{theme:"dark",displayMode:"fullscreen"}};
 else if(message.method==="tools/call") response=call(message.params.name,message.params.arguments||{});
 else return;
 event.source.postMessage({jsonrpc:"2.0",id:message.id,result:response},"*");
});
</script></body></html>`;

const server = createServer((request, response) => {
  if (request.url === "/widget") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(widget);
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(host);
  }
});

const port = Number(process.argv[2] ?? 4173);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${port}\n`);
});
