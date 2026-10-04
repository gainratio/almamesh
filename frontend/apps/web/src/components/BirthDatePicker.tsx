import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker as MuiDatePicker } from '@mui/x-date-pickers/DatePicker';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import dayjs, { Dayjs } from 'dayjs';
import { colors } from '@almamesh/constants';

interface BirthDatePickerProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  className?: string;
}

// Custom dark theme matching the app's design (same as TimePicker)
const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: colors.accent.gold, // Gold accent
    },
    background: {
      default: colors.background.tertiary,
      paper: colors.background.tertiary,
    },
    text: {
      primary: colors.text.body,
      secondary: colors.text.secondary,
    },
  },
  components: {
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            backgroundColor: colors.background.tertiary,
            borderRadius: '0.5rem',
            fontSize: '1.125rem',
            '& fieldset': {
              borderColor: colors.ui.border,
            },
            '&:hover fieldset': {
              borderColor: colors.ui.borderLight,
            },
            '&.Mui-focused fieldset': {
              borderColor: colors.accent.gold,
              borderWidth: '2px',
            },
          },
          '& .MuiOutlinedInput-input': {
            color: colors.text.body,
            padding: '16px',
          },
          '& .MuiInputAdornment-root .MuiSvgIcon-root': {
            color: colors.text.secondary,
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundColor: colors.background.tertiary,
          border: `1px solid ${colors.ui.border}`,
          borderRadius: '0.5rem',
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: colors.text.secondary,
          '&:hover': {
            backgroundColor: 'rgba(201, 162, 39, 0.1)',
          },
        },
      },
    },
    MuiTypography: {
      styleOverrides: {
        root: {
          color: colors.text.body,
        },
      },
    },
  },
});

// Calendar-specific styles via sx props
const calendarSx = {
  backgroundColor: colors.background.tertiary,
  // Day cells
  '& .MuiPickersDay-root': {
    color: colors.text.body,
    '&:hover': {
      backgroundColor: colors.ui.border,
    },
    '&.Mui-selected': {
      backgroundColor: colors.accent.gold,
      color: colors.background.tertiary,
      fontWeight: 600,
      '&:hover': {
        backgroundColor: colors.accent['gold-bright'],
      },
    },
    '&.MuiPickersDay-today': {
      borderColor: colors.accent.gold,
    },
  },
  // Week day labels
  '& .MuiDayCalendar-weekDayLabel': {
    color: colors.text.secondary,
  },
  // Calendar header
  '& .MuiPickersCalendarHeader-root': {
    color: colors.text.body,
  },
  '& .MuiPickersCalendarHeader-switchViewButton': {
    color: colors.text.body,
  },
  '& .MuiPickersCalendarHeader-label': {
    color: colors.text.body,
  },
  // Year picker
  '& .MuiPickersYear-yearButton': {
    color: colors.text.body,
    '&:hover': {
      backgroundColor: colors.ui.border,
    },
    '&.Mui-selected': {
      backgroundColor: colors.accent.gold,
      color: colors.background.tertiary,
      fontWeight: 600,
      '&:hover': {
        backgroundColor: colors.accent['gold-bright'],
      },
    },
  },
  // Month picker
  '& .MuiPickersMonth-monthButton': {
    color: colors.text.body,
    '&:hover': {
      backgroundColor: colors.ui.border,
    },
    '&.Mui-selected': {
      backgroundColor: colors.accent.gold,
      color: colors.background.tertiary,
      fontWeight: 600,
      '&:hover': {
        backgroundColor: colors.accent['gold-bright'],
      },
    },
  },
};

const MIN_DATE = dayjs('1900-01-01');

/**
 * Birth date picker component using MUI X DatePicker
 * Accepts and returns Date objects (native JavaScript Date)
 * Displays in MM/DD/YYYY format
 *
 * The picker holds an internal DRAFT Dayjs value and only propagates
 * complete, in-range dates to the parent (MUI emits null for ANY incomplete
 * state — mid-typing and cleared sections alike — so null never propagates;
 * the parent keeps the last committed date, matching the previous product
 * behavior where Onboarding dropped nulls). Fully controlling MUI's field
 * from the parent caused a real-browser day-1 bug:
 * while the year is half-typed the field emits "complete" values with bogus
 * years (0001/0019/0198 for 1988); echoing those back as the controlled
 * `value` prop forces MUI to resync its sections mid-edit, which corrupted
 * the day section (typed 08 -> committed 07) and swallowed the first
 * Continue click via the forced re-render. jsdom's synchronous flush hides
 * the race; the Playwright probe against a preview build reproduces it.
 *
 * SECOND RACE (2026-10-02 release, "typing lost while the engine boots"):
 * MUI X 8.29's field publishes an INVALID Dayjs for a half-typed year (its
 * strict parse rejects "0001") and restores the typed section on the next
 * render through a ref that its own every-commit `useEffect` clears. If a
 * keystroke lands after an unrelated commit of the field (a progress report
 * re-rendering the page) but before that commit's passive effects have run,
 * React flushes the stale effect first, the ref is gone, and the resync from
 * the invalid value empties every section: "08/08/YYYY" -> "MM/DD/YYYY".
 * Two guards close it: the picker is memoized so unrelated parent commits
 * never include the field (no stale effect to flush), and every keystroke
 * first settles React (`flushSync`) so nothing is pending when MUI arms the
 * ref. Covered by "survives re-renders mid-typing" in the unit suite and the
 * CPU-throttled Playwright probe.
 */
function BirthDatePickerImpl({ value, onChange, className }: BirthDatePickerProps) {
  // Draft buffer: the field renders from this, never from a mid-edit echo.
  const [draft, setDraft] = useState<Dayjs | null>(() => (value ? dayjs(value) : null));
  // Timestamp of the last value THIS picker emitted upward, so a parent
  // re-render echoing our own emission is never treated as an external reset.
  const lastEmittedMs = useRef<number | null>(value ? value.getTime() : null);
  // The latest onChange, read at emission time. Parents (Onboarding) pass a
  // fresh closure on every render; holding it in a ref lets the memo below
  // ignore it, so a parent re-render alone never reaches the MUI field.
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  // Sync parent -> draft ONLY for genuine external changes (profile reset,
  // store rehydration), i.e. when the parent value differs from what we
  // last emitted. Our own echoes are ignored, so in-progress typing is
  // never clobbered.
  useEffect(() => {
    const incomingMs = value ? value.getTime() : null;
    if (incomingMs !== lastEmittedMs.current) {
      lastEmittedMs.current = incomingMs;
      setDraft(value ? dayjs(value) : null);
    }
  }, [value]);

  // Settle React before MUI handles a keystroke: flushing a (trivial) sync
  // update first runs any passive effects still pending from an earlier
  // commit, so the every-commit effect inside MUI's field cannot fire between
  // this keystroke arming its section-restore ref and the render that reads
  // it. keydown precedes the browser's text insertion (and MUI's `input`
  // handler) in the same task, so nothing can be pending by then.
  const [, settle] = useReducer((n: number) => n + 1, 0);
  const settleBeforeKeystroke = () => {
    flushSync(() => settle());
  };

  // A date is committable when it is parseable AND within the picker's own
  // bounds; mid-typing years like 0198 fail this and stay draft-only.
  const isCommittable = (d: Dayjs): boolean =>
    d.isValid() && !d.isBefore(MIN_DATE, 'day') && !d.isAfter(dayjs(), 'day');

  const handleChange = (newValue: Dayjs | null) => {
    setDraft(newValue);
    // Only complete, in-range dates propagate up. MUI emits null for any
    // incomplete state (mid-typing, a cleared section, a full clear) and
    // "complete" values with half-typed years — both stay in the draft.
    if (newValue !== null && isCommittable(newValue)) {
      const date = newValue.toDate();
      lastEmittedMs.current = date.getTime();
      onChangeRef.current(date);
    }
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <div className={className || "w-full"} onKeyDownCapture={settleBeforeKeystroke}>
          <MuiDatePicker
            value={draft}
            onChange={handleChange}
            format="MM/DD/YYYY"
            maxDate={dayjs()}
            minDate={MIN_DATE}
            openTo="year"
            views={['year', 'month', 'day']}
            yearsOrder="desc"
            slotProps={{
              textField: {
                fullWidth: true,
              },
              popper: {
                sx: {
                  zIndex: 1300,
                  '& .MuiPaper-root': {
                    backgroundColor: colors.background.tertiary,
                    border: `1px solid ${colors.ui.border}`,
                    borderRadius: '0.5rem',
                  },
                },
              },
              layout: {
                sx: {
                  backgroundColor: colors.background.tertiary,
                },
              },
              toolbar: {
                sx: {
                  backgroundColor: colors.background.elevated,
                  borderBottom: `1px solid ${colors.ui.border}`,
                  '& .MuiTypography-root': {
                    color: colors.text.body,
                  },
                },
              },
              actionBar: {
                sx: {
                  backgroundColor: colors.background.tertiary,
                  borderTop: `1px solid ${colors.ui.border}`,
                },
              },
            }}
            sx={{
              width: '100%',
              '& .MuiPickersLayout-contentWrapper': calendarSx,
            }}
          />
        </div>
      </LocalizationProvider>
    </ThemeProvider>
  );
}

const sameDate = (a: Date | null, b: Date | null): boolean =>
  a === null ? b === null : b !== null && a.getTime() === b.getTime();

/**
 * Re-renders only when the committed date or the className changes. A parent
 * re-render with the same date (engine progress, i18n, store churn) stops
 * here, so the MUI field inside is never part of an unrelated commit.
 */
export const BirthDatePicker = memo(
  BirthDatePickerImpl,
  (prev, next) => sameDate(prev.value, next.value) && prev.className === next.className,
);
