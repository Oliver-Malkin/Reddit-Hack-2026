import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { BackgroundScene } from './scenes/BackgroundScene';
import { PuzzleScene } from './scenes/PuzzleScene';

// The Memphis-styled background scene auto-starts and launches the interactive puzzle
// layer on top of itself.
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#f2f0e9',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1024,
    height: 768,
  },
  scene: [BackgroundScene, PuzzleScene],
};

// Dev-only handle for debugging from the browser console (window.__game).
declare global {
  // Window augmentation requires interface merging — the one place a type alias can't do it.
  interface Window {
    __game?: Game;
  }
}

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  window.__game = StartGame('game-container');
});
