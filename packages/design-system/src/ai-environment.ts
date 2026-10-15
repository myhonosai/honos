export const HON_COMMAND_TOKENS = {
  space: { xs: '6px', sm: '10px', md: '16px', lg: '24px', xl: '36px', xxl: '56px' },
  typography: {
    display: "700 clamp(2rem, 4vw, 4.6rem)/0.98 'Plus Jakarta Sans', sans-serif",
    heading: "700 1.25rem/1.15 'Plus Jakarta Sans', sans-serif",
    body: "500 0.875rem/1.55 Inter, sans-serif",
    label: "700 0.68rem/1 'JetBrains Mono', monospace",
  },
  workStates: [
    { id: 'READY', label: 'Ready', color: '#38e3b8' },
    { id: 'THINKING', label: 'Thinking', color: '#8a8dff' },
    { id: 'WORKING', label: 'Working', color: '#4fa8ff' },
    { id: 'WAITING_FOR_APPROVAL', label: 'Waiting for Approval', color: '#ffbc4a' },
    { id: 'COMPLETED', label: 'Completed', color: '#4fe0aa' },
    { id: 'NEEDS_ATTENTION', label: 'Needs Attention', color: '#ff647d' },
  ],
} as const;

export const HON_AI_TEAM = [
  { id: 'alex', name: 'Alex', title: 'General Manager', signal: 'Leadership', color: '#37a7ff', portrait: '/ai/alex.webp' },
  { id: 'chad', name: 'Chad', title: 'Enrollment Director', signal: 'Growth', color: '#ff5876', portrait: '/ai/chad.webp' },
  { id: 'maya', name: 'Maya', title: 'Student Success Manager', signal: 'Care', color: '#ff70c1', portrait: '/ai/maya.webp' },
  { id: 'marcus', name: 'Marcus', title: 'Marketing Director', signal: 'Creativity', color: '#9a71ff', portrait: '/ai/marcus.webp' },
  { id: 'jordan', name: 'Jordan', title: 'Operations Manager', signal: 'Stability', color: '#41e2c1', portrait: '/ai/jordan.webp' },
  { id: 'claire', name: 'Claire', title: 'Business Performance Manager', signal: 'Analytics', color: '#ffc65b', portrait: '/ai/claire.webp' },
  { id: 'lena', name: 'Lena', title: 'Creative & Commerce Manager', signal: 'Imagination', color: '#d881ff', portrait: '/ai/lena.webp' },
] as const;

export type HonAiTeamMember = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly signal: string;
  readonly color: string;
  readonly portrait: string;
};
export type HonAiTeamId = HonAiTeamMember['id'];

export const HON_REFERENCE_SCREEN_STATES = {
  complete: { label: 'HON Complete', description: 'AI Command Center · School Owner View' },
  hq: { label: 'HON HQ', description: 'AI Command Center · SaaS Owner View' },
  core: { label: 'HON Core', description: 'School Management · Conventional Operations' },
  parent: { label: 'Parent App + Eian', description: 'Family-safe student experience' },
  mobile: { label: 'Mobile HON Complete', description: 'Big-button command experience' },
} as const;
