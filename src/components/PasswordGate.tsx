import { useState } from 'react';
import type { FormEvent } from 'react';
import { ACCESS_PASSWORD, unlock } from '../lib/password';

/**
 * Site access password gate: rendered in place of the whole app (all
 * routes) until the password is entered. The panel stays a narrow card
 * on phones (see `.gate-panel` in index.css).
 */
export function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (value === ACCESS_PASSWORD) {
      unlock();
      onUnlock();
    } else {
      setError(true);
      setValue('');
    }
  };

  return (
    <div className="gate">
      <div className="gate-panel">
        <div className="gate-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M4 2l16 10-16 10V2z" fill="currentColor" />
          </svg>
        </div>
        <h1 className="gate-title">
          <span className="logo-text" data-text="UNVIDEO">
            UNVIDEO
          </span>
        </h1>
        <p className="gate-sub">此站点受密码保护 // 请输入访问密码</p>
        <form className="gate-form" onSubmit={submit}>
          <input
            className="gate-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="访问密码"
            aria-label="访问密码"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
            autoFocus
          />
          <button type="submit">进入</button>
        </form>
        {error ? <p className="hint">密码错误，请重试</p> : null}
      </div>
    </div>
  );
}
