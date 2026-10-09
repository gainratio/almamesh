---
name: almamesh-frontend
description: Frontend development expertise for AlmaMesh - React, Vite, Tailwind CSS, Zustand state management, and Vedic astrology UI components. Use when working on React components, styling, or frontend features.
---

You are the AlmaMesh Frontend Expert, specialized in React web development for the Vedic astrology platform.

## Project Structure

```
frontend/apps/web/
├── src/
│   ├── main.tsx              # Vite entry point
│   ├── App.tsx               # Root app with providers
│   ├── index.css             # Global Tailwind styles
│   ├── pages/                # Route pages
│   ├── components/           # Reusable components
│   │   ├── ui/               # Design system primitives
│   │   ├── chart/            # Chart visualization
│   │   └── onboarding/       # Onboarding-specific
│   ├── lib/                  # Core libraries
│   │   ├── api/              # API client layer
│   │   └── utils/            # Utility functions
│   ├── stores/               # Zustand stores
│   └── hooks/                # Custom React hooks
├── e2e/                      # Playwright E2E tests
├── public/                   # Static assets
├── tailwind.config.ts        # Tailwind theme
└── vite.config.ts            # Vite config
```

## Core Technologies

- **Vite**: Fast HMR with optimized builds
- **React Router v7**: Type-safe navigation
- **Tailwind CSS**: Utility-first styling
- **Zustand**: Lightweight state management
- **React Query**: Server state caching
- **Axios**: HTTP client with interceptors
- **Framer Motion**: Smooth animations
- **Lucide React**: Icon library

## Development Commands

```bash
cd frontend

# Setup
bun install                              # Install dependencies

# Development
bun run --filter @almamesh/web dev       # Start dev server (port 3000)

# Quality
bun run --filter @almamesh/web typecheck # TypeScript check
bun run lint                            # ESLint, every workspace
bun run --filter @almamesh/web build     # Production build

# E2E Tests
cd apps/web && bunx playwright test
```

## Design System

### Color Palette (Cosmic Dark Theme)
```javascript
colors: {
  background: { primary: '#0A0A1A', secondary: '#12122A', tertiary: '#1A1A3A' },
  text: { primary: '#FFFFFF', secondary: '#A0A0B0', muted: '#606070' },
  accent: { gold: '#FFD700', purple: '#8B5CF6', blue: '#3B82F6' },
  planet: {
    sun: '#FFD700', moon: '#E0E0E0', mars: '#FF4444',
    mercury: '#00AA00', jupiter: '#FFAA00', venus: '#FF69B4',
    saturn: '#4444FF', rahu: '#808080', ketu: '#606060',
  },
}
```

### Component Pattern
```tsx
<div className="flex-1 bg-background-primary p-4">
  <h1 className="text-text-primary text-lg font-semibold">Title</h1>
</div>

<Button variant="primary" className="w-full">Generate Chart</Button>
```

## Navigation Flows

### Authentication
```
/landing → /login → /dashboard (has chart) or /onboarding (new user)
```

### Onboarding
```
/onboarding/name → birth-date → birth-time → birth-location → loading → /dashboard
```

### Main App
```
/dashboard  - Daily insights
/chart      - Birth chart visualization
/chat       - AI Q&A interface
/profile    - Settings & account
```

## API Integration

### API Client (lib/api/client.ts)
```typescript
export const apiClient = createApiClient();
// Auto-attaches Bearer token, handles 401 → logout
```

### API Types (lib/api/types.ts)
```typescript
interface BirthChartGenerationRequest {
  name: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  latitude: number;
  longitude: number;
}
```

### Zustand Store Pattern
```typescript
export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      authState: 'anonymous',
      user: null,
      login: async (email, password) => { ... },
      logout: async () => { ... },
    }),
    { name: 'almamesh-auth', storage: createJSONStorage(() => localStorage) }
  )
);
```

## Vedic Astrology Constants

```typescript
export const PLANETS = {
  sun: { name: 'Sun', symbol: '☉', sanskrit: 'Surya' },
  moon: { name: 'Moon', symbol: '☽', sanskrit: 'Chandra' },
  // ...
};

export const SIGNS = {
  aries: { name: 'Aries', symbol: '♈', sanskrit: 'Mesha', element: 'Fire' },
  // ...12 signs
};

export const NAKSHATRAS = [
  { name: 'Ashwini', lord: 'ketu', deity: 'Ashwini Kumaras' },
  // ...27 nakshatras
];
```

## Quality Standards

1. **Type Safety**: No TypeScript errors, strict mode
2. **Responsive**: Mobile-first design
3. **Accessibility**: Screen reader compatible, ARIA labels
4. **Performance**: Minimize re-renders
5. **API Alignment**: Types match backend Pydantic models
6. **Dark Theme**: Cosmic dark palette throughout

## Environment Configuration

```bash
# .env
VITE_API_URL=http://localhost:8001/api/v1
```
