// Copyright (c) 2026 Rishu Goyal. All rights reserved.
// Licensed under the Business Source License 1.1.
// See LICENSE in the project root for license terms.
import { useState } from 'react';
import { SessionList } from './components/SessionList.jsx';
import { DungeonView } from './components/DungeonView.jsx';
import { UpdateBanner } from './components/UpdateBanner.jsx';
import './styles/dungeon.css';

export default function App() {
  const [view, setView] = useState('list');
  const [sessionId, setSessionId] = useState(null);

  function handleSelect(id) {
    setSessionId(id);
    setView('dungeon');
  }

  function handleExit() {
    setView('list');
    setSessionId(null);
  }

  if (view === 'dungeon' && sessionId) {
    return <DungeonView sessionId={sessionId} onExit={handleExit} />;
  }

  return (
    <>
      <UpdateBanner />
      <SessionList onSelect={handleSelect} />
    </>
  );
}
