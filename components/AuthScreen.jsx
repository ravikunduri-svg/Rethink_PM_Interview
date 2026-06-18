import { useState } from 'react';
import { supabase } from '../lib/supabase';

const C = {
  purple: "#5B4FCF", purpleL: "#EEF0FF", purpleM: "#8B83E0", purpleD: "#3B3190",
  g50: "#F9FAFB", g100: "#F3F4F6", g200: "#E5E7EB", g300: "#D1D5DB",
  g400: "#9CA3AF", g500: "#6B7280", g600: "#4B5563", g700: "#374151",
  g800: "#1F2937", g900: "#111827", white: "#FFFFFF",
};

export default function AuthScreen({ onGuestContinue }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function sendMagicLink() {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) setError(err.message);
    else setSent(true);
    setLoading(false);
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', sans-serif; background: ${C.g50}; color: ${C.g900}; }
      `}</style>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 420, background: C.white, border: `1px solid ${C.g200}`, borderRadius: 16, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,.07)' }}>
          <div style={{ marginBottom: 32, textAlign: 'center' }}>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 700, color: C.purple, letterSpacing: -0.5 }}>Rethink</div>
            <div style={{ fontSize: 13, color: C.g500, marginTop: 4 }}>PM Career Intelligence Platform</div>
          </div>

          {sent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 16 }}>📬</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.g900, marginBottom: 8 }}>Check your email</div>
              <div style={{ fontSize: 13, color: C.g600, lineHeight: 1.6 }}>
                We sent a magic link to <strong>{email}</strong>.<br />
                Click it to sign in — no password needed.
              </div>
              <div style={{ marginTop: 20, fontSize: 12, color: C.g400 }}>
                Didn't get it?{' '}
                <span
                  onClick={() => { setSent(false); setError(null); }}
                  style={{ color: C.purple, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Try again
                </span>
              </div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.g900, marginBottom: 6 }}>Sign in to your account</div>
                <div style={{ fontSize: 13, color: C.g500, lineHeight: 1.6 }}>
                  Enter your email and we'll send a magic link — no password required.
                  Your story bank, scores, and session history are saved automatically.
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: C.g700, marginBottom: 6 }}>Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendMagicLink(); }}
                  placeholder="you@example.com"
                  autoFocus
                  style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: '10px 12px', border: `1px solid ${error ? '#FCA5A5' : C.g300}`, borderRadius: 8, outline: 'none', lineHeight: 1.5 }}
                />
              </div>

              {error && (
                <div style={{ marginBottom: 14, padding: '10px 12px', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, fontSize: 12, color: '#DC2626' }}>
                  {error}
                </div>
              )}

              <button
                onClick={sendMagicLink}
                disabled={!email.trim() || loading}
                style={{ width: '100%', padding: '11px 16px', background: !email.trim() || loading ? C.g200 : C.purple, color: !email.trim() || loading ? C.g500 : '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: !email.trim() || loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', transition: 'all .15s' }}
              >
                {loading ? 'Sending...' : 'Send magic link →'}
              </button>

              <div style={{ marginTop: 20, padding: '12px 14px', background: C.purpleL, borderRadius: 10, fontSize: 12, color: C.purpleD, lineHeight: 1.6 }}>
                <strong>🔒 Your data is private.</strong> Every candidate's story bank, scores, and history are stored separately — only you can see yours.
              </div>

              <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.g200}`, textAlign: 'center' }}>
                <button
                  onClick={onGuestContinue}
                  style={{ fontSize: 13, color: C.g500, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                >
                  Try without signing up →
                </button>
                <div style={{ fontSize: 11, color: C.g400, marginTop: 4 }}>Progress won't be saved across sessions</div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
