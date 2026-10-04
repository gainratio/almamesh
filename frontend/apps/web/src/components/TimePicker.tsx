import { useEffect, useRef, useState } from 'react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { TimePicker as MuiTimePicker } from '@mui/x-date-pickers/TimePicker';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import dayjs, { Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { colors } from '@almamesh/constants';

// Enable custom parse format plugin for parsing HH:mm strings
dayjs.extend(customParseFormat);

interface TimePickerProps {
  value: string; // HH:mm format
  onChange: (time: string) => void; // Returns HH:mm format
  className?: string;
}

// Custom dark theme matching the app's design
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
    MuiList: {
      styleOverrides: {
        root: {
          backgroundColor: colors.background.tertiary,
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
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
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          color: colors.accent.gold,
          '&:hover': {
            backgroundColor: 'rgba(201, 162, 39, 0.1)',
          },
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

// Shared styles for digital clock sections
const digitalClockSx = {
  backgroundColor: colors.background.tertiary,
  '& .MuiMultiSectionDigitalClockSection-root': {
    '&:after': {
      borderColor: colors.ui.border,
    },
  },
  '& .MuiMultiSectionDigitalClockSection-item': {
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

// Shared styles for analog clock
const clockSx = {
  backgroundColor: colors.background.elevated,
  '& .MuiClock-clock': {
    backgroundColor: colors.background.tertiary,
  },
  '& .MuiClock-pin': {
    backgroundColor: colors.accent.gold,
  },
  '& .MuiClockPointer-root': {
    backgroundColor: colors.accent.gold,
  },
  '& .MuiClockPointer-thumb': {
    backgroundColor: colors.accent.gold,
    borderColor: colors.accent.gold,
  },
  '& .MuiClockNumber-root': {
    color: colors.text.body,
    '&.Mui-selected': {
      backgroundColor: colors.accent.gold,
      color: colors.background.tertiary,
    },
  },
};

// Convert HH:mm string to Dayjs object for the picker
const timeToDayjs = (timeStr: string): Dayjs | null => {
  if (!timeStr) return null;
  const parsed = dayjs(timeStr, 'HH:mm', true);
  return parsed.isValid() ? parsed : null;
};

/**
 * Time picker component using MUI X TimePicker
 * Accepts and returns time as string in "HH:mm" format (24-hour)
 * Displays in 12-hour AM/PM format for user convenience
 *
 * The picker holds an internal DRAFT Dayjs value and only propagates
 * complete, valid times ("HH:mm") to the parent — the same draft-buffer
 * pattern as BirthDatePicker, fixing the same controlled-component desync
 * class: the old fully-controlled wiring echoed every emission back as the
 * controlled `value` (re-parsed into a fresh Dayjs identity each render,
 * with incomplete/cleared states propagating '' into the store), forcing
 * MUI to resync its sections mid-edit; the forced re-render swallowed the
 * first Continue click after typing the time. jsdom/happy-dom's synchronous
 * flush hides the race; the Playwright probe against a preview build
 * reproduces it.
 */
export function TimePicker({ value, onChange, className }: TimePickerProps) {
  // Draft buffer: the field renders from this, never from a mid-edit echo.
  const [draft, setDraft] = useState<Dayjs | null>(() => timeToDayjs(value));
  // The last "HH:mm" THIS picker emitted upward, so a parent re-render
  // echoing our own emission is never treated as an external reset.
  const lastEmitted = useRef<string>(value);

  // Sync parent -> draft ONLY for genuine external changes (profile reset,
  // store rehydration), i.e. when the parent value differs from what we
  // last emitted. Our own echoes are ignored, so in-progress typing is
  // never clobbered.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setDraft(timeToDayjs(value));
    }
  }, [value]);

  const handleChange = (newValue: Dayjs | null) => {
    setDraft(newValue);
    // Only complete, valid times propagate up. MUI emits null for any
    // incomplete state (mid-typing, a cleared section, a full clear) —
    // those stay in the draft and the parent keeps the last committed time.
    if (newValue !== null && newValue.isValid()) {
      const time = newValue.format('HH:mm');
      lastEmitted.current = time;
      onChange(time);
    }
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <div className={className || "w-full"}>
          <MuiTimePicker
            value={draft}
            onChange={handleChange}
            ampm={true}
            timeSteps={{ minutes: 1 }}
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
                  '& .MuiPickersLayout-contentWrapper': {
                    backgroundColor: colors.background.tertiary,
                  },
                },
              },
              toolbar: {
                sx: {
                  backgroundColor: colors.background.elevated,
                  borderBottom: `1px solid ${colors.ui.border}`,
                  '& .MuiTypography-root': {
                    color: colors.text.body,
                  },
                  '& .Mui-selected': {
                    color: `${colors.accent.gold} !important`,
                  },
                },
              },
              actionBar: {
                sx: {
                  backgroundColor: colors.background.tertiary,
                  borderTop: `1px solid ${colors.ui.border}`,
                },
              },
              digitalClockSectionItem: {
                sx: {
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
              },
            }}
            sx={{
              width: '100%',
              '& .MuiMultiSectionDigitalClock-root': digitalClockSx,
              '& .MuiTimeClock-root': clockSx,
            }}
          />
        </div>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
