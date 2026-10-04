/**
 * MUI X Date Pickers v9 contract for both onboarding pickers.
 *
 * v9 renders a sectioned (contenteditable) field, not an <input>. Two v8-era
 * props are therefore dead: `textField.placeholder` leaked onto the root div as
 * an invalid attribute, and `InputProps` is dropped with a console warning.
 * These tests pin the migrated behavior: no MUI warning, no stray attribute,
 * and the empty field still shows its section placeholders.
 */
import '../../i18n/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { BirthDatePicker } from '../BirthDatePicker';
import { TimePicker } from '../TimePicker';

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function sectionTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="spinbutton"]')).map(
    (s) => s.textContent ?? '',
  );
}

describe.each([
  ['BirthDatePicker', () => <BirthDatePicker value={null} onChange={() => {}} />, ['MM', 'DD', 'YYYY']],
  ['TimePicker', () => <TimePicker value="" onChange={() => {}} />, ['hh', 'mm', 'aa']],
])('%s on MUI X v9', (_name, ui, sections) => {
  it('logs no MUI X prop warnings or React unknown-attribute errors', () => {
    render(ui());
    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
    expect(logged).not.toMatch(/MUI X|no longer supported|unknown|React does not recognize/i);
  });

  it('does not leak a placeholder attribute onto the field root', () => {
    const { container } = render(ui());
    expect(container.querySelector('[placeholder]')).toBeNull();
  });

  it('shows the empty-section placeholders', () => {
    const { container } = render(ui());
    expect(sectionTexts(container)).toEqual(sections);
  });
});
