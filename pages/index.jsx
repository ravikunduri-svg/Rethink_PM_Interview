import dynamic from 'next/dynamic';

// ssr: false because the app uses browser-only APIs and all AI calls
// go through /api/chat — there is nothing meaningful to server-render.
const App = dynamic(() => import('../components/RethinkApp'), { ssr: false });

export default function Home() {
  return <App />;
}
