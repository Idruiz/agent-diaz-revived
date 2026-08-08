import type { JobKind, JobView, ConversationView, MessageView } from "../shared/contracts";

async function call<T>(url:string,init?:RequestInit):Promise<T>{
  const r=await fetch(url,{...init,headers:{...(init?.body instanceof FormData?{}:{"Content-Type":"application/json"}),...init?.headers}});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);return data as T;
}
export const api={
  session:()=>call<{authenticated:boolean}>("/api/session"),
  login:(password:string)=>call("/api/login",{method:"POST",body:JSON.stringify({password})}),
  logout:()=>call("/api/logout",{method:"POST",body:"{}"}),
  jobs:()=>call<JobView[]>("/api/jobs"),
  skills:()=>call<SkillView[]>("/api/skills"),
  conversations:()=>call<ConversationView[]>("/api/conversations"),
  conversation:(id:string)=>call<ConversationView&{messages:MessageView[]}>(`/api/conversations/${id}`),
  createConversation:(title?:string)=>call<ConversationView>("/api/conversations",{method:"POST",body:JSON.stringify({title})}),
  job:(id:string)=>call<JobView&{artifacts:ArtifactView[];approvals:ApprovalView[]}>(`/api/jobs/${id}`),
  createJob:(input:{prompt:string;kind:JobKind;fileIds:string[];conversationId:string})=>call<JobView>("/api/jobs",{method:"POST",body:JSON.stringify(input)}),
  retry:(id:string)=>call<JobView>(`/api/jobs/${id}/retry`,{method:"POST",body:"{}"}),
  cancel:(id:string)=>call(`/api/jobs/${id}/cancel`,{method:"POST",body:"{}"}),
  upload:async(files:File[])=>{const fd=new FormData();files.forEach(f=>fd.append("files",f));return call<UploadView[]>("/api/uploads",{method:"POST",body:fd});},
  decide:(id:string,decision:"approved"|"rejected")=>call(`/api/approvals/${id}`,{method:"POST",body:JSON.stringify({decision})})
};
export interface UploadView{id:string;name:string;mime:string;size:number}
export interface ArtifactView{id:string;jobId:string;name:string;mime:string;size:number;createdAt:string}
export interface ApprovalView{id:string;jobId:string;tool:string;summary:string;arguments:unknown;status:string;createdAt:string}
export interface SkillView{id:string;kind:JobKind;name:string;description:string;tools:string[];artifact:string;minVisuals:number;validation:string[];approvalPolicy:string}
