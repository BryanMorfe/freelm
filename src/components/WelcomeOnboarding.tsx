import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Plus, X } from 'lucide-react';
import type { Connection, ThinkingMode } from '../types';
import { newConnection } from '../lib/state';
import { listModels } from '../lib/api';
import { assertConnection } from '../lib/connection-validation';
import { userFacingError } from '../lib/user-facing-error';
import ConnectionFields from './ConnectionFields';
import ModelCatalogEditor from './ModelCatalogEditor';
import { SettingsGroup } from './SettingsList';
import './welcome-onboarding.css';

export default function WelcomeOnboarding({
  open,
  onClose,
  onSave,
  secureStorage,
  secureStorageChecked,
  thinkingPresets,
  discoverModels = listModels,
}: {
  discoverModels?: typeof listModels;
  open: boolean;
  onClose: () => void;
  onSave: (connection: Connection) => Promise<void>;
  secureStorage: boolean;
  secureStorageChecked?: boolean;
  thinkingPresets?: ThinkingMode[];
}) {
  const [step, setStep] = useState<'welcome' | 'connection' | 'models'>('welcome');
  const [draft, setDraft] = useState(newConnection);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'discovery' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      request.current?.abort();
      element.close();
      previous?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, step]);
  const update = (patch: Partial<Connection>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError('');
  };
  function close() {
    if (busy === 'saving') return;
    request.current?.abort();
    onClose(); // Draft stays in this mounted component for reopening during this session.
  }
  function next() {
    try {
      assertConnection(draft);
      setError('');
      setStep('models');
    } catch (e) {
      setError(userFacingError(e));
    }
  }
  async function discover() {
    if (locked.current) return;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy('discovery');
    setError('');
    setNotice('');
    try {
      const models = await discoverModels(draft, controller.signal);
      if (!controller.signal.aborted) {
        update({ discoveredModels: models });
        setNotice(
          models.length
            ? `Found ${models.length} models. Choose one below to configure.`
            : 'No models listed. You can add an API model ID below.',
        );
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(userFacingError(e));
    } finally {
      if (request.current === controller) {
        request.current = null;
        locked.current = false;
        setBusy(null);
      }
    }
  }
  async function save() {
    if (locked.current) return;
    if (editing) {
      setError('Apply or cancel the model changes before finishing setup.');
      return;
    }
    try {
      assertConnection(draft);
      if (!draft.catalog?.length)
        throw new Error('Add and configure at least one model before finishing setup.');
    } catch (e) {
      setError(userFacingError(e));
      return;
    }
    locked.current = true;
    setBusy('saving');
    setError('');
    try {
      await onSave(draft);
      setDraft(newConnection());
      setStep('welcome');
      onClose();
    } catch (e) {
      setError(userFacingError(e));
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="welcome-onboarding"
      aria-labelledby={`${id}-title`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <button
        className="welcome-close"
        aria-label="Close setup and keep draft"
        disabled={busy === 'saving'}
        onClick={close}
      >
        <X size={18} />
      </button>
      {step === 'welcome' && (
        <div className="welcome-clouds" aria-hidden="true">
          <svg viewBox="0 0 750 164" preserveAspectRatio="xMidYMid slice">
            <defs>
              <filter id={`${id}-cloud`} x="-15%" y="-40%" width="130%" height="180%">
                <feTurbulence type="fractalNoise" baseFrequency=".018 .035" numOctaves="3" seed="8" result="noise" />
                <feDisplacementMap in="SourceGraphic" in2="noise" scale="12" />
                <feGaussianBlur stdDeviation="5" />
              </filter>
              <linearGradient id={`${id}-cloud-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop className="welcome-cloud-rim" offset="0%" />
                <stop className="welcome-cloud-body" offset="80%" />
              </linearGradient>
            </defs>
            <g filter={`url(#${id}-cloud)`} fill={`url(#${id}-cloud-fill)`}>
              <path className="welcome-cloud-bank welcome-cloud-bank-far"
                d="M-180 110 C-80 30 30 124 130 84 S290 32 400 84 S560 118 690 62 S840 56 940 96 L940 320 L-180 320Z" />
              <path className="welcome-cloud-bank welcome-cloud-bank-near"
                d="M-180 140 C-110 100 -40 142 20 120 C55 105 64 113 90 97 C120 72 155 89 182 78 C215 60 238 75 258 86 C290 80 300 109 340 114 C385 132 420 140 460 119 C490 104 505 116 530 99 C552 77 574 94 595 78 C630 52 655 76 676 65 C710 49 740 78 770 83 C825 100 880 68 940 84 L940 320 L-180 320Z" />
            </g>
          </svg>
        </div>
      )}
      <div className="welcome-content settings-fields">
        <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
          {step === 'welcome'
            ? 'Welcome!'
            : step === 'connection'
              ? 'Add API connection'
              : 'Configure your models'}
        </h1>
        {step === 'welcome' ? (
          <>
            <p>
              FreeLM allows you to set up multiple API connections so that you can enjoy a wide
              variety of models, including frontier, open models, and your own hosted models.
              All data for FreeLM lives on your computer, and allows you to connect multiple
              FreeLM instances that synchronize seamlessly.
            </p>
            <p>
              To get started, add an API connection and configure your models for text, images,
              voice, and more.
            </p>
            <div className="welcome-actions">
              <button className="primary-button" onClick={() => setStep('connection')}>
                <Plus size={18} /> Add API Connection
              </button>
              <button className="welcome-later" onClick={close}>
                Set up later <ArrowRight size={18} />
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              {step === 'connection'
                ? 'Connect a local server or a hosted API. Your draft stays here as you move between steps.'
                : 'Discover available models or add their API IDs manually. Configure a mode for each model you want to use.'}
            </p>
            <fieldset disabled={!!busy} className="welcome-fields">
              <div hidden={step !== 'connection'}>
                <SettingsGroup title="Connection details">
                  <ConnectionFields
                    connection={draft}
                    updateConnection={update}
                    secureStorage={secureStorage}
                    secureStorageChecked={secureStorageChecked}
                  />
                </SettingsGroup>
              </div>
              <div hidden={step !== 'models'}>
                <button className="secondary-button" onClick={() => void discover()}>
                  Discover models
                </button>
                <ModelCatalogEditor
                  catalog={draft.catalog ?? []}
                  discoveredModels={draft.discoveredModels}
                  models={draft.models}
                  modelIds={Object.values(draft.models)}
                  chatApi={draft.chatApi}
                  thinkingPresets={thinkingPresets}
                  onChange={(catalog) => update({ catalog })}
                  onDefaultsChange={(models) => update({ models })}
                  onEditingChange={setEditing}
                />
              </div>
            </fieldset>
            {busy === 'discovery' && (
              <button
                className="secondary-button"
                onClick={() => {
                  request.current?.abort();
                  setNotice('Discovery cancelled. You can retry or add models manually.');
                }}
              >
                Cancel discovery
              </button>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && (
              <p className="welcome-error" role="alert">
                {error}
              </p>
            )}
            <footer className="welcome-footer">
              <button
                className="secondary-button"
                disabled={!!busy || editing}
                onClick={() => {
                  setError('');
                  setStep(step === 'models' ? 'connection' : 'welcome');
                }}
              >
                Back
              </button>
              <button
                className="primary-button"
                disabled={!!busy || editing}
                onClick={step === 'connection' ? next : () => void save()}
              >
                {busy === 'saving' ? 'Saving…' : step === 'connection' ? 'Next' : 'Finish setup'}
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
