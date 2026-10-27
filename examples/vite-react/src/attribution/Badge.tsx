export function Badge({ label }: { label: string }) {
  return <span className="badge" style={{ display: 'inline-block', padding: 4, border: '1px solid #333' }}>{label}</span>;
}
