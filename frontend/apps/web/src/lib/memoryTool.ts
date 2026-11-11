/**
 * `remember_fact` tool: saves a concise, PII-stripped context note on the
 * active profile (`profileMemory` store) so AlmaMesh remembers durable life,
 * career, relationship, preference, or milestone context across all threads.
 */
import { defineTool, z, type ToolDef } from '@almamesh/llm/toolLoop';
import {
  MAX_MEMORY_FACT_CHARS,
  PROFILE_MEMORY_CATEGORIES,
  sanitizeMemoryFactText,
  useProfilesStore,
  type ProfileMemoryCategory,
} from '@almamesh/store';

const REMEMBER_FACT_TOOL_NAME = 'remember_fact';
const REMEMBER_FACT_STATUS_LABEL = 'Saving to profile memory…';

export interface RememberFactArgs {
  readonly fact: string;
  readonly category: ProfileMemoryCategory;
}

interface RememberFactSaved {
  readonly status: 'remembered';
  readonly id: string;
  readonly fact: string;
  readonly category: ProfileMemoryCategory;
}

interface RememberFactSkipped {
  readonly status: 'ignored';
  readonly reason: 'empty_after_sanitization' | 'no_active_profile';
}

type RememberFactResult = RememberFactSaved | RememberFactSkipped;

export interface MemoryToolInput {
  readonly profileId: string | undefined;
}

const ARGS_SCHEMA: z.ZodType<RememberFactArgs> = z
  .object({
    fact: z
      .string()
      .trim()
      .min(3, 'fact must be a concise note of at least 3 characters')
      .max(MAX_MEMORY_FACT_CHARS, `fact must be at most ${MAX_MEMORY_FACT_CHARS} characters`)
      .describe('Short durable context note in plain words (no coordinates, emails, phone numbers, or birth dates), e.g. "Building an AI fintech startup".'),
    category: z
      .enum(PROFILE_MEMORY_CATEGORIES)
      .describe('Category of the note: "life", "career", "relationship", "preference", or "milestone".'),
  })
  .strict();

const DESCRIPTION = [
  'Save a concise durable context note on this profile so future chat threads remember it.',
  'Call when the user shares lasting personal context worth remembering across conversations (e.g. career focus, major life transition, study/spiritual practice, or reading preferences).',
  'Never pass coordinates, birth dates, emails, phone numbers, or other people\'s full names.',
].join(' ');

function resolveTargetProfileId(explicitId: string | undefined): string | null {
  const store = useProfilesStore.getState();
  if (explicitId && store.profiles[explicitId]) return explicitId;
  if (store.activeProfileId && store.profiles[store.activeProfileId]) return store.activeProfileId;
  return null;
}

export function createRememberFactTool(input: MemoryToolInput): ToolDef<RememberFactArgs> {
  return defineTool({
    name: REMEMBER_FACT_TOOL_NAME,
    description: DESCRIPTION,
    input: ARGS_SCHEMA,
    statusLabel: REMEMBER_FACT_STATUS_LABEL,
    unlocksAnswer: (result) => (result as { status?: string } | null)?.status === 'remembered',
    execute: async (args, context): Promise<RememberFactResult> => {
      const cleaned = sanitizeMemoryFactText(args.fact);
      if (!cleaned) return { status: 'ignored', reason: 'empty_after_sanitization' };
      const targetId = resolveTargetProfileId(input.profileId);
      if (!targetId) return { status: 'ignored', reason: 'no_active_profile' };
      const outcome = useProfilesStore.getState().addProfileMemoryFact(targetId, {
        text: cleaned,
        category: args.category,
        createdAt: context.now.toISOString(),
      });
      if (!outcome.ok) return { status: 'ignored', reason: 'empty_after_sanitization' };
      return {
        status: 'remembered',
        id: outcome.fact.id,
        fact: outcome.fact.text,
        category: outcome.fact.category,
      };
    },
  });
}
