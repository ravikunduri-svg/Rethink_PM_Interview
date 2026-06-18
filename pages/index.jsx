import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { supabase } from '../lib/supabase';
import AuthScreen from '../components/AuthScreen';

const App = dynamic(() => import('../components/RethinkApp'), { ssr: false });

export default function Home() {
  // undefined = still checking, null = not logged in, object = logged in user
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (user === undefined) return null; // brief loading flash before session check resolves
  if (!user) return <AuthScreen />;
  return <App user={user} />;
}
