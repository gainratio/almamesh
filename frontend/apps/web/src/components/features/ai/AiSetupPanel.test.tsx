import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import {
  CHAT_CLOUD_MODEL,
  configureLlmSettingsPersistence,
  hydrateLlmSettings,
  readLlmSettings,
  RECOMMENDED_CLOUD_MODEL,
  type ProviderConfig,
} from '@almamesh/llm';
import { AiSetupPanel, type AiSetupPanelProps } from './AiSetupPanel';
import { LLM_SETTINGS_CHANGED_EVENT, notifyLlmSettingsChanged } from '../../../lib/llmSettingsEvents';
import { hydrateSlowModelSuggestion } from '../../../lib/modelSuggestion';

function readSaved(): Record<string, unknown> {
  return { ...readLlmSettings() };
}

const STUB_CONFIG: ProviderConfig = {
  engine: 'openai-http',
  model: RECOMMENDED_CLOUD_MODEL,
  privacyMode: 'cloud_premium',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-xyz',
};
const resolveConfig = () => STUB_CONFIG;

// The OpenRouter balance read is auto-triggered once a guided connect saves, so
// every test that reaches an OpenRouter-configured state must inject a stub —
// otherwise the default would hit the real network.
const fetchCredits = vi.fn().mockResolvedValue({ totalCredits: 10, totalUsage: 2, remaining: 8 });
const fetchModels = vi.fn().mockResolvedValue([]);

/** A rejection shaped like the @almamesh/llm LlmRequestError (duck-typed). */
function requestError(message: string, status: number): Error {
  return Object.assign(new Error(message), { name: 'LlmRequestError', status });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued promise continuation and timer-0 task run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('AiSetupPanel — OpenRouter-first, test-on-save', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });

  it('renders the two choices: AI off, and a guided Connect-AI card with an Advanced panel', () => {
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
    expect(screen.getByTestId('tier-none')).toBeTruthy();
    expect(screen.getByTestId('tier-cloud')).toBeTruthy();
    expect(screen.getByTestId('llm-openrouter-key')).toBeTruthy();
    expect(screen.getByTestId('llm-openrouter-link').getAttribute('href')).toBe(
      'https://openrouter.ai/keys',
    );
    // Advanced custom-endpoint fields exist (inside the <details>, still in DOM).
    expect(screen.getByTestId('llm-advanced-summary')).toBeTruthy();
    expect(screen.getByTestId('llm-api-base')).toBeTruthy();
    expect(screen.getByTestId('llm-model')).toBeTruthy();
    expect(screen.getByTestId('llm-chat-model')).toBeTruthy();
  });

  it('disables the guided Save until an OpenRouter key is entered', () => {
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
    expect((screen.getByTestId('llm-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    expect((screen.getByTestId('llm-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('rehydrates an open form when another realm replaces AI settings', async () => {
    hydrateLlmSettings(
      JSON.stringify({ apiKey: 'old-key', apiBase: 'https://openrouter.ai/api/v1' }),
    );
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={vi.fn()}
      />,
    );
    expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe('old-key');

    hydrateLlmSettings(
      JSON.stringify({ apiKey: 'imported-key', apiBase: 'https://openrouter.ai/api/v1' }),
    );
    notifyLlmSettingsChanged({ replace: true });

    await waitFor(() =>
      expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe(
        'imported-key',
      ),
    );
  });

  it('guided save persists the OpenRouter preset and, on a passing test, shows Connected', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('Connected'),
    );
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ config: STUB_CONFIG, signal: expect.any(AbortSignal) }),
    );
    const saved = readSaved();
    expect(saved.apiBase).toBe('https://openrouter.ai/api/v1');
    expect(saved.apiKey).toBe('sk-or-abc');
    expect(saved.interpretationModel).toBe(RECOMMENDED_CLOUD_MODEL);
    expect(saved.chatModel).toBe(CHAT_CLOUD_MODEL);
    // Literal on purpose — the constant asserted against itself guards nothing.
    expect(saved.chatModel).toBe('deepseek/deepseek-v4.1-flash');
    expect(saved.privacyMode).toBe('cloud_premium');
  });

  it('shows a SPECIFIC error (bad key) when the connectivity test fails — config still saved', async () => {
    const testConnection = vi.fn().mockRejectedValue(requestError('returned 401 Unauthorized', 401));
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() => {
      const result = screen.getByTestId('llm-connection-result').textContent ?? '';
      expect(result).toContain('API key rejected');
    });
    // The config is still persisted so the user can fix & retry — not lost.
    expect(readSaved().apiKey).toBe('bad-key');
  });

  it('maps an out-of-credits failure to billing copy, not a model error', async () => {
    const testConnection = vi
      .fn()
      .mockRejectedValue(requestError('returned 402 Payment Required: Insufficient credits', 402));
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('out of credits'),
    );
  });

  it("surfaces the provider's actual reason when a failure is otherwise unclassifiable (400)", async () => {
    // The exact reported bug: a reasoning model 400s a request param → the blind
    // "unknown" verdict must now carry the provider's own message so it's not a
    // dead-end. (The probe no longer sends max_tokens, but a future 400 still
    // needs to be diagnosable.)
    const err = Object.assign(new Error('LLM endpoint returned 400 Bad Request'), {
      name: 'LlmRequestError',
      status: 400,
      body: '{"error":{"message":"Invalid \'max_output_tokens\': Expected a value >= 16, but got 1 instead."}}',
    });
    const testConnection = vi.fn().mockRejectedValue(err);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={testConnection}
      />,
    );
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() => expect(screen.getByTestId('llm-connection-detail')).toBeTruthy());
    expect(screen.getByTestId('llm-connection-detail').textContent).toContain(
      'Expected a value >= 16',
    );
    // The generic verdict still shows alongside the specific provider reason.
    expect(screen.getByTestId('llm-connection-result').textContent).toContain("Couldn't connect");
  });

  it('disables the advanced Save until an endpoint is entered (no empty-form probe)', () => {
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
    expect((screen.getByTestId('llm-save-advanced') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('llm-api-base'), { target: { value: 'http://localhost:11434/v1' } });
    expect((screen.getByTestId('llm-save-advanced') as HTMLButtonElement).disabled).toBe(false);
  });

  it('advanced save persists a hand-typed endpoint + tiered models and tests them', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

    fireEvent.change(screen.getByTestId('llm-api-base'), {
      target: { value: 'http://localhost:11434/v1' },
    });
    fireEvent.change(screen.getByTestId('llm-model'), { target: { value: 'llama3.1' } });
    fireEvent.change(screen.getByTestId('llm-chat-model'), { target: { value: 'llama3.1' } });
    fireEvent.click(screen.getByTestId('llm-save-advanced'));

    await waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
    const saved = readSaved();
    expect(saved.apiBase).toBe('http://localhost:11434/v1');
    expect(saved.interpretationModel).toBe('llama3.1');
    expect(saved.chatModel).toBe('llama3.1');
  });

  it('does not report success when the canonical SQLite settings write fails', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    const flushSettings = vi.fn().mockRejectedValue(new Error('canonical SQLite write failed'));
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={testConnection}
        flushSettings={flushSettings}
      />,
    );

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), {
      target: { value: 'sk-or-abc' },
    });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain("Couldn't save"),
    );
    expect(flushSettings).toHaveBeenCalledOnce();
    expect(testConnection).not.toHaveBeenCalled();
    expect(screen.getByTestId('llm-connection-result').textContent).not.toContain('Connected');
  });

  it('ignores a stale probe result after the config is edited mid-test (no false Connected)', async () => {
    // A probe we can resolve on demand, so we can interleave an edit before it settles.
    let resolveProbe: (() => void) | undefined;
    const testConnection = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveProbe = res;
        }),
    );
    render(<AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('Testing'),
    );

    // User edits the key while the first probe is still in flight → the pending
    // verdict is for the OLD config and must be discarded.
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-different' } });
    expect(screen.queryByTestId('llm-connection-result')).toBeNull();

    // The stale probe finally resolves — it must NOT paint a Connected verdict.
    resolveProbe?.();
    await settle();
    expect(screen.queryByTestId('llm-connection-result')).toBeNull();
  });
});

describe('AiSetupPanel — OpenRouter credits balance', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => hydrateLlmSettings(null));

  it('reads the balance after a guided OpenRouter connect and shows dollars remaining', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        testConnection={testConnection}
        fetchCredits={fetchCredits} fetchModels={fetchModels}
      />,
    );

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    // The balance is auto-read against the SAME resolved OpenRouter config.
    await waitFor(() =>
      expect(screen.getByTestId('llm-credits-value').textContent).toContain('$8.00'),
    );
    expect(screen.getByTestId('llm-credits-value').textContent).toContain('$10.00');
    expect(fetchCredits).toHaveBeenCalledWith(
      expect.objectContaining({ config: STUB_CONFIG, signal: expect.any(AbortSignal) }),
    );
  });

  it('never reads credits for a LOCAL endpoint (no key sent to loopback)', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        testConnection={testConnection}
        fetchCredits={fetchCredits} fetchModels={fetchModels}
      />,
    );

    fireEvent.change(screen.getByTestId('llm-api-base'), {
      target: { value: 'http://localhost:11434/v1' },
    });
    fireEvent.change(screen.getByTestId('llm-model'), { target: { value: 'llama3.1' } });
    fireEvent.click(screen.getByTestId('llm-save-advanced'));

    await waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
    // Local provider → no balance line, and crucially no credits fetch at all.
    expect(screen.queryByTestId('llm-credits')).toBeNull();
    expect(fetchCredits).not.toHaveBeenCalled();
  });

  it('degrades to an "unavailable" line (never a crash) when the balance read fails', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    const failingCredits = vi.fn().mockRejectedValue(requestError('returned 401 Unauthorized', 401));
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        testConnection={testConnection}
        fetchCredits={failingCredits}
        fetchModels={fetchModels}
      />,
    );

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));

    await waitFor(() => expect(screen.getByTestId('llm-credits-error')).toBeTruthy());
    expect(screen.queryByTestId('llm-credits-value')).toBeNull();
  });

  it('re-reads the balance when Refresh is pressed', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        testConnection={testConnection}
        fetchCredits={fetchCredits} fetchModels={fetchModels}
      />,
    );

    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    fireEvent.click(screen.getByTestId('llm-save'));
    await waitFor(() => expect(screen.getByTestId('llm-credits-value')).toBeTruthy());
    expect(fetchCredits).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('llm-credits-refresh'));
    await waitFor(() => expect(fetchCredits).toHaveBeenCalledTimes(2));
  });
});

describe('AiSetupPanel — live OpenRouter model picker', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => hydrateLlmSettings(null));

  it('reads the OpenRouter catalog and offers real models in the picker', async () => {
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-xyz',
        privacyMode: 'cloud_premium',
      }),
    );
    const catalog = vi.fn().mockResolvedValue([
      { id: 'anthropic/claude-4', name: 'Claude 4' },
      { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ]);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={catalog}
        testConnection={vi.fn()}
      />,
    );

    // The catalog read hits the OpenRouter base — and carries NO key (a public
    // read; resolveProviderConfig omits it without an explicit key env).
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    const passedConfig = catalog.mock.calls[0][0].config as ProviderConfig;
    expect(passedConfig.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(passedConfig.apiKey).toBeUndefined();

    // A live-catalog status line appears; focusing the picker offers a real slug.
    await waitFor(() => expect(screen.getByTestId('llm-catalog-status')).toBeTruthy());
    fireEvent.focus(screen.getByTestId('llm-model'));
    await waitFor(() => expect(screen.getByText('openai/gpt-5.6-sol')).toBeTruthy());
  });

  it('never reads the catalog for a LOCAL endpoint (no request to loopback)', () => {
    hydrateLlmSettings(
      JSON.stringify({ apiBase: 'http://localhost:11434/v1', privacyMode: 'local_only' }),
    );
    const catalog = vi.fn().mockResolvedValue([]);
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={catalog}
        testConnection={vi.fn()}
      />,
    );
    expect(catalog).not.toHaveBeenCalled();
    expect(screen.queryByTestId('llm-catalog-status')).toBeNull();
  });
});

// A user still on z-ai/glm-5.3-flash gets a one-time, dismissible suggestion to
// switch to the new default. Their saved model is never changed without a click.
describe('AiSetupPanel — one-time switch suggestion for glm-5.3-flash users', () => {
  const GLM = 'z-ai/glm-5.3-flash';
  const seed = (models: Record<string, string>) =>
    hydrateLlmSettings(
      JSON.stringify({
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-kept',
        privacyMode: 'cloud_premium',
        ...models,
      }),
    );
  const renderSettings = (testConnection = vi.fn().mockResolvedValue(undefined)) =>
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={testConnection}
      />,
    );

  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
  });

  it('pins the new default: deepseek-v4.1-flash', () => {
    expect(RECOMMENDED_CLOUD_MODEL).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('suggests the switch with the measured reason, and switching keeps the key and chat model', async () => {
    seed({ model: GLM, interpretationModel: GLM, chatModel: 'minimax/minimax-m2.7' });
    const testConnection = vi.fn().mockResolvedValue(undefined);
    renderSettings(testConnection);

    const card = screen.getByTestId('model-switch-suggestion');
    expect(card.textContent).toContain('DeepSeek V4.1 Flash');
    expect(card.textContent).toMatch(/GLM 5\.3 Flash/);
    expect(card.textContent).toMatch(/\d+ s/);
    expect(readSaved().interpretationModel).toBe(GLM);

    fireEvent.click(screen.getByTestId('model-switch-accept'));
    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    const saved = readSaved();
    expect(saved.interpretationModel).toBe('deepseek/deepseek-v4.1-flash');
    expect(saved.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(saved.chatModel).toBe('minimax/minimax-m2.7');
    expect(saved.apiKey).toBe('sk-or-kept');
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
  });

  it('switches a glm chat model too, but leaves a non-glm tier alone', async () => {
    seed({ model: 'openai/gpt-5.6-sol', interpretationModel: 'openai/gpt-5.6-sol', chatModel: GLM });
    renderSettings();
    fireEvent.click(screen.getByTestId('model-switch-accept'));
    await waitFor(() => expect(readSaved().chatModel).toBe('deepseek/deepseek-v4.1-flash'));
    expect(readSaved().interpretationModel).toBe('openai/gpt-5.6-sol');
  });

  it('stays dismissed after "Keep GLM", across remounts, and changes nothing', () => {
    seed({ model: GLM, interpretationModel: GLM });
    const first = renderSettings();
    fireEvent.click(screen.getByTestId('model-switch-dismiss'));
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
    first.unmount();
    renderSettings();
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
    expect(readSaved().interpretationModel).toBe(GLM);
  });

  it('never suggests (or rewrites) for a user on another model, e.g. the old v4-pro default', () => {
    seed({ model: 'deepseek/deepseek-v4-pro', interpretationModel: 'deepseek/deepseek-v4-pro' });
    renderSettings();
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
    expect(readSaved().interpretationModel).toBe('deepseek/deepseek-v4-pro');
  });

  it('does not suggest a cloud model to a local endpoint user', () => {
    hydrateLlmSettings(
      JSON.stringify({ apiBase: 'http://localhost:11434/v1', model: GLM, interpretationModel: GLM }),
    );
    renderSettings();
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
  });
});

describe('AiSetupPanel — surface props (showOffChoice, intro)', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });

  const renderPanel = (props: Partial<AiSetupPanelProps> = {}) =>
    render(
      <AiSetupPanel
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={vi.fn()}
        {...props}
      />,
    );

  it('shows the AI-off choice by default, so Settings needs no props', () => {
    renderPanel();
    expect(screen.getByTestId('tier-none')).toBeTruthy();
  });

  it('hides the AI-off choice when showOffChoice is false', () => {
    renderPanel({ showOffChoice: false });
    expect(screen.queryByTestId('tier-none')).toBeNull();
    expect(screen.getByTestId('tier-cloud')).toBeTruthy();
    expect(screen.getByTestId('llm-openrouter-key')).toBeTruthy();
  });

  it('renders the intro above the choices', () => {
    renderPanel({ intro: <p>Your reading is a full report.</p> });
    const intro = screen.getByTestId('ai-setup-intro');
    expect(intro.textContent).toBe('Your reading is a full report.');
    const order = intro.compareDocumentPosition(screen.getByTestId('tier-cloud'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no intro wrapper when none is given', () => {
    renderPanel();
    expect(screen.queryByTestId('ai-setup-intro')).toBeNull();
  });

  it('shows the AI disclosure in the onboarding variant', () => {
    renderPanel({ showOffChoice: false, intro: <p>Your key stays on this device.</p> });
    const disclosure = screen.getByTestId('tier-cloud-honesty');
    expect(disclosure.textContent).toContain('can reveal your birth date');
    expect(disclosure.textContent).toContain('without your name or birth date');
  });

  it('keeps the local-only refusal warning in the onboarding variant', () => {
    renderPanel({ showOffChoice: false });
    fireEvent.change(screen.getByTestId('llm-api-base'), { target: { value: 'https://example.com/v1' } });
    expect(screen.getByTestId('llm-privacy-warning').textContent).toContain('local-only');
  });
});

describe('AiSetupPanel — onConnected', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });
  afterEach(() => {
    hydrateLlmSettings(null);
    hydrateSlowModelSuggestion(null);
    configureLlmSettingsPersistence(undefined);
  });

  const renderPanel = (props: Partial<AiSetupPanelProps>) =>
    render(
      <AiSetupPanel resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} {...props} />,
    );
  const saveKey = (key: string) => {
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: key } });
    fireEvent.click(screen.getByTestId('llm-save'));
  };

  it('reports connected once, with the saved status, after a passing probe', async () => {
    const onConnected = vi.fn();
    renderPanel({ onConnected, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(onConnected).toHaveBeenCalledWith({ kind: 'openrouter', label: 'OpenRouter', configured: true });
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('does not report connected on a failed probe', async () => {
    const onConnected = vi.fn();
    renderPanel({
      onConnected,
      testConnection: vi.fn().mockRejectedValue(requestError('returned 401 Unauthorized', 401)),
    });
    saveKey('bad-key');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('API key rejected'),
    );
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('reports connected only after the settings are durable', async () => {
    const onConnected = vi.fn();
    const flush = deferred();
    const flushSettings = vi.fn(() => flush.promise);
    renderPanel({ onConnected, flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(flushSettings).toHaveBeenCalledOnce());
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    flush.resolve();
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('does not report connected when the settings write fails', async () => {
    const onConnected = vi.fn();
    const testConnection = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      onConnected,
      flushSettings: vi.fn().mockRejectedValue(new Error('canonical SQLite write failed')),
      testConnection,
    });
    saveKey('sk-or-abc');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain("Couldn't save"),
    );
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    // A config that will vanish on reload is never probed.
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('does not report connected when a newer save superseded the probe', async () => {
    const onConnected = vi.fn();
    const first = deferred();
    const testConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    renderPanel({ onConnected, testConnection });

    saveKey('sk-or-first');
    await waitFor(() => expect(testConnection).toHaveBeenCalledOnce());
    saveKey('sk-or-second');
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());

    first.resolve();
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(readSaved().apiKey).toBe('sk-or-second');
  });

  it('does not report connected when the config is edited mid-probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    renderPanel({ onConnected, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-abc');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('Testing'),
    );
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-edited' } });
    probe.resolve();
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });

  // Regression (Task 1.5b): a superseded save whose flush settles LATE must not
  // repaint over the newer save's verdict — neither "Testing…" nor "Couldn't save".
  const supersededFlush = async (settleFirst: (flush: ReturnType<typeof deferred<void>>) => void) => {
    const onConnected = vi.fn();
    const firstFlush = deferred();
    const flushSettings = vi
      .fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValue(undefined);
    renderPanel({ onConnected, flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });

    saveKey('sk-or-first');
    await waitFor(() => expect(flushSettings).toHaveBeenCalledOnce());
    saveKey('sk-or-second');
    await waitFor(() =>
      expect(screen.getByTestId('llm-connection-result').textContent).toContain('Connected'),
    );
    expect(onConnected).toHaveBeenCalledOnce();

    settleFirst(firstFlush);
    await settle();
    return onConnected;
  };

  it('keeps the newer Connected verdict when a superseded save flushes late', async () => {
    const onConnected = await supersededFlush((flush) => flush.resolve());
    expect(screen.getByTestId('llm-connection-result').textContent).toContain('Connected');
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onConnected).toHaveBeenCalledWith({ kind: 'openrouter', label: 'OpenRouter', configured: true });
  });

  it('keeps the newer Connected verdict when a superseded save rejects late', async () => {
    const onConnected = await supersededFlush((flush) =>
      flush.reject(new Error('canonical SQLite write failed')),
    );
    const result = screen.getByTestId('llm-connection-result').textContent;
    expect(result).toContain('Connected');
    expect(result).not.toContain("Couldn't save");
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('refreshes the status surfaces, but keeps the edit, when a save flushes after a field edit', async () => {
    const onConnected = vi.fn();
    const flush = deferred();
    const testConnection = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onConnected, testConnection, flushSettings: vi.fn(() => flush.promise) });
    const changed = vi.fn();
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, changed);
    try {
      saveKey('sk-or-first');
      await waitFor(() => expect(readSaved().apiKey).toBe('sk-or-first'));
      // An edit (not a re-save) supersedes save A while its flush is in flight.
      fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-edited' } });
      flush.resolve();
      await settle();

      // A's write is durable, so the badge and the header signal reflect it…
      expect(changed).toHaveBeenCalled();
      expect(screen.getByTestId('tier-cloud-active')).toBeTruthy();
      expect(screen.queryByTestId('tier-none-active')).toBeNull();
      // …but the user's in-progress edit and the (absent) verdict are untouched.
      expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe('sk-or-edited');
      expect(screen.queryByTestId('llm-connection-result')).toBeNull();
      expect(testConnection).not.toHaveBeenCalled();
      expect(onConnected).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(LLM_SETTINGS_CHANGED_EVENT, changed);
    }
  });

  // ── Round 2 (grader PR #328): every way the screen can go away or change owner
  // mid-flight must cancel the pending onConnected and keep the newest verdict.
  const verdict = () => screen.queryByTestId('llm-connection-result')?.textContent ?? '(none)';

  it('does not report connected after unmount, and aborts the in-flight probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    let signal: AbortSignal | undefined;
    const { unmount } = renderPanel({
      onConnected,
      testConnection: vi.fn((opts: { signal?: AbortSignal }) => {
        signal = opts.signal;
        return probe.promise;
      }),
    });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    unmount();
    expect(signal?.aborted).toBe(true);
    probe.resolve();
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('does not report connected when a remote Replace lands mid-probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    renderPanel({ onConnected, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    act(() => notifyLlmSettingsChanged({ replace: true }));
    probe.resolve();
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    expect(verdict()).toBe('(none)');
  });

  it('still reports connected when an ordinary (non-Replace) settings signal lands mid-probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    renderPanel({ onConnected, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    act(() => notifyLlmSettingsChanged());
    probe.resolve();
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('does not report connected when AI is turned off mid-probe', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    const testConnection = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => probe.promise);
    renderPanel({ onConnected, testConnection });
    saveKey('sk-or-first');
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    saveKey('sk-or-second');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    fireEvent.click(screen.getByTestId('tier-none-select'));
    await waitFor(() => expect(screen.queryByTestId('tier-none-active')).toBeTruthy());
    probe.resolve();
    await settle();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(verdict()).toBe('(none)');
    expect(readSaved().apiKey).toBe('');
  });

  it('reports exactly once, for the newer save, when an older probe passes first', async () => {
    const onConnected = vi.fn();
    const first = deferred();
    const second = deferred();
    const testConnection = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderPanel({ onConnected, testConnection });
    saveKey('sk-or-first');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    saveKey('sk-or-second');
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(2));
    first.resolve();
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    second.resolve();
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('keeps the newer Testing verdict when a superseded save rejects late', async () => {
    const onConnected = vi.fn();
    const firstFlush = deferred();
    const probe = deferred();
    const flushSettings = vi
      .fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValue(undefined);
    renderPanel({ onConnected, flushSettings, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-first');
    await waitFor(() => expect(flushSettings).toHaveBeenCalledOnce());
    saveKey('sk-or-second');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    firstFlush.reject(new Error('late'));
    await settle();
    expect(verdict()).toContain('Testing');
    probe.resolve();
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it('ignores a superseded probe that FAILS late (no error painted over the edit)', async () => {
    const onConnected = vi.fn();
    const probe = deferred();
    renderPanel({ onConnected, testConnection: vi.fn(() => probe.promise) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Testing'));
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-edited' } });
    probe.reject(requestError('returned 401 Unauthorized', 401));
    await settle();
    expect(verdict()).toBe('(none)');
    expect(onConnected).not.toHaveBeenCalled();
  });

  // CONTRACT REVERSED (round 4): a failed turn-off used to restore the previous
  // in-memory settings (AI on). flushPortablePersistence can reject because ANOTHER
  // store failed while the off row committed, so restoring fails OPEN. The turn-off
  // now fails CLOSED: memory and the badge stay off, and the storage error shows.
  it('shows a storage error, and fails closed (AI off in memory and on the badge), when turning AI off cannot be saved', async () => {
    const flushSettings = vi.fn().mockResolvedValue(undefined);
    renderPanel({ flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Connected'));
    flushSettings.mockRejectedValueOnce(new Error('canonical SQLite write failed'));
    fireEvent.click(screen.getByTestId('tier-none-select'));
    await waitFor(() => expect(verdict()).toContain("Couldn't save"));
    // The privacy fence wins: no key, local_only, for the rest of the session.
    expect(readSaved().apiKey).toBe('');
    expect(readSaved().privacyMode).toBe('local_only');
    // And the badge is honest about it.
    expect(screen.getByTestId('tier-none-active')).toBeTruthy();
    expect(screen.queryByTestId('tier-cloud-active')).toBeNull();
  });

  it('turns AI off only after the off write is durable', async () => {
    const offFlush = deferred();
    const flushSettings = vi.fn().mockResolvedValue(undefined);
    renderPanel({ flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-abc');
    await waitFor(() => expect(verdict()).toContain('Connected'));
    flushSettings.mockImplementationOnce(() => offFlush.promise);
    fireEvent.click(screen.getByTestId('tier-none-select'));
    await settle();
    expect(screen.getByTestId('tier-cloud-active')).toBeTruthy();
    expect(screen.queryByTestId('tier-none-active')).toBeNull();
    await act(async () => {
      offFlush.resolve();
      await settle();
    });
    expect(screen.getByTestId('tier-none-active')).toBeTruthy();
  });

  it('restores the previous in-memory settings when a save cannot be made durable', async () => {
    hydrateLlmSettings(
      JSON.stringify({ apiKey: 'sk-or-old', apiBase: 'https://openrouter.ai/api/v1', privacyMode: 'cloud_premium' }),
    );
    renderPanel({
      flushSettings: vi.fn().mockRejectedValue(new Error('canonical SQLite write failed')),
      testConnection: vi.fn().mockResolvedValue(undefined),
    });
    saveKey('sk-or-new');
    await waitFor(() => expect(verdict()).toContain("Couldn't save"));
    // The unsaved key must not be live in memory until the next reload.
    expect(readSaved().apiKey).toBe('sk-or-old');
    // The form still holds what the user typed, so they can retry.
    expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe('sk-or-new');
  });

  // Connected, then Turn AI off (its flush held), then a newer save connects. The
  // off flush settling late must not repaint over the newer Connected verdict.
  const offSupersededBySave = async (settleOff: (flush: ReturnType<typeof deferred<void>>) => void) => {
    const onConnected = vi.fn();
    const offFlush = deferred();
    const flushSettings = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onConnected, flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-first');
    await waitFor(() => expect(verdict()).toContain('Connected'));
    flushSettings.mockImplementationOnce(() => offFlush.promise);
    fireEvent.click(screen.getByTestId('tier-none-select'));
    await settle();
    saveKey('sk-or-second');
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));
    expect(verdict()).toContain('Connected');
    await act(async () => {
      settleOff(offFlush);
      await settle();
    });
    return onConnected;
  };

  it('keeps the newer Connected verdict when a superseded Turn-AI-off flushes late', async () => {
    const onConnected = await offSupersededBySave((flush) => flush.resolve());
    expect(verdict()).toContain('Connected');
    expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe('sk-or-second');
    expect(screen.getByTestId('tier-cloud-active')).toBeTruthy();
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer Connected verdict when a superseded Turn-AI-off rejects late', async () => {
    await offSupersededBySave((flush) => flush.reject(new Error('canonical SQLite write failed')));
    expect(verdict()).toContain('Connected');
    expect(verdict()).not.toContain("Couldn't save");
  });

  it('refreshes the status surfaces, but keeps the edit, when a Turn-AI-off flushes after a field edit', async () => {
    const offFlush = deferred();
    const flushSettings = vi.fn().mockResolvedValue(undefined);
    renderPanel({ flushSettings, testConnection: vi.fn().mockResolvedValue(undefined) });
    saveKey('sk-or-first');
    await waitFor(() => expect(verdict()).toContain('Connected'));
    flushSettings.mockImplementationOnce(() => offFlush.promise);
    const changed = vi.fn();
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, changed);
    try {
      fireEvent.click(screen.getByTestId('tier-none-select'));
      await settle();
      // An edit (not a save) supersedes the turn-off while its flush is in flight.
      fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-edited' } });
      await act(async () => {
        offFlush.resolve();
        await settle();
      });
      // The off write is durable, so the badge and the header signal reflect it…
      expect(changed).toHaveBeenCalled();
      expect(screen.getByTestId('tier-none-active')).toBeTruthy();
      expect(screen.queryByTestId('tier-cloud-active')).toBeNull();
      // …but the in-progress edit and the (absent) verdict are untouched.
      expect((screen.getByTestId('llm-openrouter-key') as HTMLInputElement).value).toBe('sk-or-edited');
      expect(verdict()).toBe('(none)');
    } finally {
      window.removeEventListener(LLM_SETTINGS_CHANGED_EVENT, changed);
    }
  });

  it('keeps Connected, logs, and raises no unhandled rejection, when an async onConnected rejects', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // A plain function, not vi.fn: Vitest's mock attaches its own handler to a
      // returned promise (settledResults), which would hide the unhandled rejection.
      let calls = 0;
      const onConnected = async () => {
        calls += 1;
        await Promise.resolve();
        throw new Error('async caller boom');
      };
      renderPanel({ onConnected, testConnection: vi.fn().mockResolvedValue(undefined) });
      saveKey('sk-or-abc');
      await waitFor(() => expect(calls).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(verdict()).toContain('Connected');
      expect(seen.map(String)).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith('[almamesh:error:app.typed_error]');
    } finally {
      consoleError.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps Connected, and raises no unhandled rejection, when onConnected throws', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const onConnected = vi.fn(() => {
        throw new Error('caller boom');
      });
      renderPanel({ onConnected, testConnection: vi.fn().mockResolvedValue(undefined) });
      saveKey('sk-or-abc');
      await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
      await new Promise((r) => setTimeout(r, 20));
      expect(verdict()).toContain('Connected');
      expect(seen.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
