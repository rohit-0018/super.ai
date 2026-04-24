import ChatPanel from '../../components/ChatPanel';

export default function ChatPage() {
  return (
    <div className="page page-narrow" style={{ paddingTop: 12, paddingBottom: 12 }}>
      <div style={{ minHeight: 'calc(100vh - 200px)' }}>
        <ChatPanel />
      </div>
    </div>
  );
}
