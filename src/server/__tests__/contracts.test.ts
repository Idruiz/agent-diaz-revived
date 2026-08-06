import{describe,expect,it}from"vitest";
import{ArtifactPlanSchema,CreateJobSchema}from"../../shared/contracts";
describe("contracts",()=>{it("rejects empty jobs",()=>{expect(CreateJobSchema.safeParse({prompt:"",kind:"chat"}).success).toBe(false)});it("rejects invented non-url sources",()=>{expect(ArtifactPlanSchema.safeParse({title:"x",sections:[{heading:"h",body:"b",bullets:[]}],sources:[{title:"s",url:"made up"}]}).success).toBe(false)});});
