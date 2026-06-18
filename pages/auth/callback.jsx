import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../../lib/supabase';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          router.replace('/');
        }
      }
    );
    return () => subscription.unsubscribe();
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', background: '#F9FAFB', color: '#374151' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700, color: '#5B4FCF', marginBottom: 12 }}>Rethink</div>
        <div style={{ fontSize: 14, color: '#6B7280' }}>Signing you in...</div>
      </div>
    </div>
  );
}
