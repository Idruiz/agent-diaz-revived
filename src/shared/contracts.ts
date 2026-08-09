import { z } from "zod";

export const JobKindSchema = z.enum([
  "chat",
  "research",
  "analysis",
  "presentation",
  "document",
  "website",
]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "building",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ModelModeSchema = z.enum(["quick", "balanced", "deep"]);
export type ModelMode = z.infer<typeof ModelModeSchema>;
export const VoiceSchema = z.enum(["marin", "cedar"]);
export type Voice = z.infer<typeof VoiceSchema>;
export const MessageStatusSchema = z.enum([
  "complete",
  "streaming",
  "failed",
  "stopped",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const CreateJobSchema = z.object({
  prompt: z.string().trim().min(2).max(30_000),
  kind: JobKindSchema,
  conversationId: z.string().uuid().optional(),
  fileIds: z.array(z.string().min(1)).max(10).default([]),
});

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});
export const UpdateConversationSettingsSchema = z.object({
  modelMode: ModelModeSchema,
});
export const StreamChatSchema = z
  .object({
    prompt: z.string().trim().min(2).max(30_000).optional(),
    conversationId: z.string().uuid(),
    fileIds: z.array(z.string().uuid()).max(10).default([]),
    retryJobId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.retryJobId && !value.prompt)
      ctx.addIssue({
        code: "custom",
        message: "prompt is required when this is not a retry",
        path: ["prompt"],
      });
  });
export const RealtimeTokenSchema = z.object({
  conversationId: z.string().uuid(),
  voice: VoiceSchema,
});
export const VoiceTurnSchema = z.object({
  conversationId: z.string().uuid(),
  userText: z.string().trim().min(1).max(12_000),
  assistantText: z.string().trim().min(1).max(30_000),
});

export interface AttachmentView {
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface ConversationView {
  id: string;
  title: string;
  status: "active" | "archived";
  summary: string | null;
  modelMode: ModelMode;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
export interface MessageView {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  jobId: string | null;
  status: MessageStatus;
  error: string | null;
  attachments: AttachmentView[];
  createdAt: string;
}

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  editedArguments: z.record(z.string(), z.unknown()).optional(),
});

export const ArtifactPlanSchema = z.object({
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional().default(""),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(180),
        body: z.string().min(1).max(8000),
        bullets: z.array(z.string().max(500)).max(12).default([]),
        speakerNotes: z.string().max(2000).optional().default(""),
        table: z
          .object({
            title: z.string().max(180),
            headers: z.array(z.string().max(100)).min(2).max(8),
            rows: z
              .array(z.array(z.string().max(300)).min(2).max(8))
              .min(1)
              .max(30),
          })
          .optional(),
        chart: z
          .object({
            title: z.string().max(180),
            type: z.enum(["bar", "line", "pie", "donut"]),
            labels: z.array(z.string().max(80)).min(2).max(12),
            series: z
              .array(
                z.object({
                  name: z.string().max(100),
                  values: z.array(z.number().finite()).min(2).max(12),
                }),
              )
              .min(1)
              .max(5),
            unit: z.string().max(40).optional().default(""),
            sourceNote: z.string().max(300).optional().default(""),
          })
          .optional(),
        diagram: z
          .object({
            title: z.string().max(180),
            nodes: z.array(z.string().max(100)).min(2).max(8),
            caption: z.string().max(300).optional().default(""),
          })
          .optional(),
        imageQuery: z.string().min(2).max(180).optional(),
      }),
    )
    .min(1)
    .max(30),
  pages: z
    .array(
      z.object({
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(50),
        title: z.string().min(1).max(120),
        description: z.string().max(240).default(""),
        sectionHeadings: z.array(z.string().min(1).max(180)).min(1).max(10),
      }),
    )
    .min(3)
    .max(6)
    .optional(),
  sources: z
    .array(z.object({ title: z.string().max(300), url: z.string().url() }))
    .max(40)
    .default([]),
});
export type ArtifactPlan = z.infer<typeof ArtifactPlanSchema>;

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  prompt: string;
  progress: number;
  message: string;
  outputText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  modelMode: ModelMode;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
}
