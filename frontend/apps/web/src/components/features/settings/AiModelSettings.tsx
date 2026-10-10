/**
 * AiModelSettings — the AI model configuration card.
 *
 * Renders `LlmModelSettings`: AI off (the default — no AI at all) and Connect
 * AI (a guided OpenRouter key, or any OpenAI-compatible endpoint under
 * "Advanced", e.g. a local Ollama). Saving runs a real connectivity probe. The
 * same resolved `ProviderConfig` drives both interpretation and chat. The
 * enclosing page supplies the heading.
 */

import { Card } from '../../ui';
import { AiSetupPanel } from '../ai/AiSetupPanel';

export function AiModelSettings() {
  return (
    <section data-testid="ai-model-settings">
      <Card className="p-5">
        <AiSetupPanel />
      </Card>
    </section>
  );
}
