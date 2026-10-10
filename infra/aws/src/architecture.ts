/** Server-owned execution catalog; no resource amounts are accepted from the client. */
export const architectures = {
  small: { cpu: '512', memory: '1024', min: 1, max: 1, azs: 1, multiAZ: false },
  medium: { cpu: '1024', memory: '2048', min: 2, max: 4, azs: 2, multiAZ: true },
  large: { cpu: '2048', memory: '4096', min: 3, max: 12, azs: 3, multiAZ: true },
} as const;
