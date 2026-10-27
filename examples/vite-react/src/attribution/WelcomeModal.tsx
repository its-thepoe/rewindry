export function WelcomeModal({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Welcome" style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)', display: 'grid', placeItems: 'center' }}>
      <div style={{ background: '#fff', padding: 24 }}>
        <p>Welcome to the board</p>
        <button type="button" onClick={onClose}>Close welcome</button>
      </div>
    </div>
  );
}
