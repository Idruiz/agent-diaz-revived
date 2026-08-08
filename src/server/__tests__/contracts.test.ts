import{describe,expect,it}from"vitest";
import{ArtifactPlanSchema,CreateJobSchema}from"../../shared/contracts";
import{providerFailureMessage}from"../openai-agent";
describe("contracts",()=>{it("rejects empty jobs",()=>{expect(CreateJobSchema.safeParse({prompt:"",kind:"chat"}).success).toBe(false)});it("rejects invented non-url sources",()=>{expect(ArtifactPlanSchema.safeParse({title:"x",sections:[{heading:"h",body:"b",bullets:[]}],sources:[{title:"s",url:"made up"}]}).success).toBe(false)});it("surfaces provider failure details",()=>{expect(providerFailureMessage({status:"failed",error:{code:"server_error",message:"Temporary provider fault"}})).toBe("OpenAI response failed (server_error): Temporary provider fault")});});
