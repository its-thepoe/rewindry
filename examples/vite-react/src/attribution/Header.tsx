import { Badge } from './Badge.tsx';

// Renders no host element of its own, so attribution must come from what it owns.
export function Header({ screen }: { screen: string }) {
  return <Badge label={`Screen: ${screen}`} />;
}
