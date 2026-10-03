import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import {
  CHAT_CLOUD_MODEL,
  LLM_SETTINGS_KEY,
  RECOMMENDED_CLOUD_MODEL,
  type ProviderConfig,
} from '@almamesh/llm';
import LlmModelSettings from './LlmModelSettings';

function readSaved(): Record<string, unknown> {
  const raw = window.localStorage.getItem(LLM_SETTINGS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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

describe('LlmModelSettings — OpenRouter-first, test-on-save', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => window.localStorage.clear());

  it('renders the two choices: AI off, and a guided Connect-AI card with an Advanced panel', () => {
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
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
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
    expect((screen.getByTestId('llm-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
    expect((screen.getByTestId('llm-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('guided save persists the OpenRouter preset and, on a passing test, shows Connected', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

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
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

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
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

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
      <LlmModelSettings
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
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={vi.fn()} />);
    expect((screen.getByTestId('llm-save-advanced') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('llm-api-base'), { target: { value: 'http://localhost:11434/v1' } });
    expect((screen.getByTestId('llm-save-advanced') as HTMLButtonElement).disabled).toBe(false);
  });

  it('advanced save persists a hand-typed endpoint + tiered models and tests them', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

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

  it('surfaces a storage failure as a verdict instead of a silent no-op — and never probes', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    try {
      render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);
      fireEvent.change(screen.getByTestId('llm-openrouter-key'), { target: { value: 'sk-or-abc' } });
      fireEvent.click(screen.getByTestId('llm-save'));

      await waitFor(() =>
        expect(screen.getByTestId('llm-connection-result').textContent).toContain("Couldn't save"),
      );
      // A config we couldn't persist must not be probed.
      expect(testConnection).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
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
    render(<LlmModelSettings resolveConfig={resolveConfig} fetchCredits={fetchCredits} fetchModels={fetchModels} testConnection={testConnection} />);

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
    await Promise.resolve();
    expect(screen.queryByTestId('llm-connection-result')).toBeNull();
  });
});

describe('LlmModelSettings — OpenRouter credits balance', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => window.localStorage.clear());

  it('reads the balance after a guided OpenRouter connect and shows dollars remaining', async () => {
    const testConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <LlmModelSettings
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
      <LlmModelSettings
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
      <LlmModelSettings
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
      <LlmModelSettings
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

describe('LlmModelSettings — live OpenRouter model picker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchCredits.mockClear();
    fetchModels.mockClear();
  });
  afterEach(() => window.localStorage.clear());

  it('reads the OpenRouter catalog and offers real models in the picker', async () => {
    window.localStorage.setItem(
      LLM_SETTINGS_KEY,
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
      <LlmModelSettings
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
    window.localStorage.setItem(
      LLM_SETTINGS_KEY,
      JSON.stringify({ apiBase: 'http://localhost:11434/v1', privacyMode: 'local_only' }),
    );
    const catalog = vi.fn().mockResolvedValue([]);
    render(
      <LlmModelSettings
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
describe('LlmModelSettings — one-time switch suggestion for glm-5.3-flash users', () => {
  const GLM = 'z-ai/glm-5.3-flash';
  const seed = (models: Record<string, string>) =>
    window.localStorage.setItem(
      LLM_SETTINGS_KEY,
      JSON.stringify({
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-kept',
        privacyMode: 'cloud_premium',
        ...models,
      }),
    );
  const renderSettings = (testConnection = vi.fn().mockResolvedValue(undefined)) =>
    render(
      <LlmModelSettings
        resolveConfig={resolveConfig}
        fetchCredits={fetchCredits}
        fetchModels={fetchModels}
        testConnection={testConnection}
      />,
    );

  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

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
    window.localStorage.setItem(
      LLM_SETTINGS_KEY,
      JSON.stringify({ apiBase: 'http://localhost:11434/v1', model: GLM, interpretationModel: GLM }),
    );
    renderSettings();
    expect(screen.queryByTestId('model-switch-suggestion')).toBeNull();
  });
});
