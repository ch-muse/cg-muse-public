import { z } from "zod";

const stringParamDefinitionSchema = z
  .object({
    type: z.literal("string"),
    default: z.string().nullable()
  })
  .strict();

const numberParamDefinitionSchema = z
  .object({
    type: z.literal("number"),
    default: z.number().nullable()
  })
  .strict();

const booleanParamDefinitionSchema = z
  .object({
    type: z.literal("boolean"),
    default: z.boolean()
  })
  .strict();

const sizeParamDefinitionSchema = z
  .object({
    type: z.literal("size"),
    default: z
      .object({
        width: z.number().int(),
        height: z.number().int()
      })
      .strict()
  })
  .strict();

const imageParamDefinitionSchema = z
  .object({
    type: z.literal("image"),
    default: z.string().nullable()
  })
  .strict();

const loraItemSchema = z
  .object({
    name: z.string().trim().min(1),
    weight: z.number().finite().optional(),
    enabled: z.boolean().optional()
  })
  .strict();

const loraListParamDefinitionSchema = z
  .object({
    type: z.literal("loraList"),
    default: z.array(loraItemSchema)
  })
  .strict();

const seedParamDefinitionSchema = z
  .object({
    type: z.literal("seed"),
    default: z
      .object({
        value: z.number().int(),
        randomize: z.boolean()
      })
      .strict()
  })
  .strict();

export const workflowParamDefinitionSchema = z.discriminatedUnion("type", [
  stringParamDefinitionSchema,
  numberParamDefinitionSchema,
  booleanParamDefinitionSchema,
  sizeParamDefinitionSchema,
  imageParamDefinitionSchema,
  loraListParamDefinitionSchema,
  seedParamDefinitionSchema
]);

const selectorTargetSchema = z
  .object({
    nodeId: z.string().trim().min(1).optional(),
    classType: z.string().trim().min(1).optional(),
    inputKey: z.string().trim().min(1).optional(),
    outputKey: z.string().trim().min(1).optional(),
    paramPath: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.nodeId && !value.classType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selector requires nodeId or classType"
      });
    }
  });

const selectorTargetsSchema = z.array(selectorTargetSchema);

export const workflowSelectorsSchema = z
  .object({
    ckpt: selectorTargetsSchema.optional(),
    outputSize: selectorTargetsSchema.optional(),
    initImage: selectorTargetsSchema.optional(),
    positive: selectorTargetsSchema.optional(),
    negative: selectorTargetsSchema.optional(),
    loras: selectorTargetsSchema.optional(),
    controlnetEnabled: selectorTargetsSchema.optional(),
    controlnetPreprocessEnabled: selectorTargetsSchema.optional(),
    controlnetModel: selectorTargetsSchema.optional(),
    preprocessModel: selectorTargetsSchema.optional(),
    controlnetStrength: selectorTargetsSchema.optional(),
    steps: selectorTargetsSchema.optional(),
    cfg: selectorTargetsSchema.optional(),
    sampler_name: selectorTargetsSchema.optional(),
    seed: selectorTargetsSchema.optional(),
    denoise: selectorTargetsSchema.optional(),
    controlnetImage: selectorTargetsSchema.optional()
  })
  .strict();

const workflowParamsSchema = z
  .object({
    ckpt: stringParamDefinitionSchema,
    outputSize: sizeParamDefinitionSchema,
    initImage: imageParamDefinitionSchema,
    positive: stringParamDefinitionSchema,
    negative: stringParamDefinitionSchema,
    loras: loraListParamDefinitionSchema,
    controlnetEnabled: booleanParamDefinitionSchema,
    controlnetPreprocessEnabled: booleanParamDefinitionSchema,
    controlnetModel: stringParamDefinitionSchema,
    preprocessModel: stringParamDefinitionSchema,
    controlnetStrength: numberParamDefinitionSchema,
    steps: numberParamDefinitionSchema,
    cfg: numberParamDefinitionSchema,
    sampler_name: stringParamDefinitionSchema,
    seed: seedParamDefinitionSchema,
    denoise: numberParamDefinitionSchema,
    controlnetImage: imageParamDefinitionSchema
  })
  .strict();

const workflowAssertSchema = z
  .object({
    type: z.string().trim().min(1),
    nodeId: z.string().trim().min(1).optional(),
    classType: z.string().trim().min(1).optional(),
    inputKey: z.string().trim().min(1).optional(),
    expected: z.unknown().optional(),
    message: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.nodeId && !value.classType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assert requires nodeId or classType"
      });
    }
  });

export const workflowSchemaZod = z
  .object({
    workflowId: z.string().trim().min(1),
    workflowPath: z.string().trim().min(1),
    params: workflowParamsSchema,
    selectors: workflowSelectorsSchema,
    asserts: z.array(workflowAssertSchema)
  })
  .strict();

export type WorkflowParamDefinition = z.infer<typeof workflowParamDefinitionSchema>;
export type WorkflowSelectorTarget = z.infer<typeof selectorTargetSchema>;
export type WorkflowSelectors = z.infer<typeof workflowSelectorsSchema>;
export type WorkflowAssert = z.infer<typeof workflowAssertSchema>;
export type WorkflowSchema = z.infer<typeof workflowSchemaZod>;
