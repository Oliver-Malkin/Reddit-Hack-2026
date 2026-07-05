import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { BackgroundScene } from './scenes/BackgroundScene';
import { PuzzleScene } from './scenes/PuzzleScene';

// The Memphis-styled background scene auto-starts and launches the interactive puzzle
// layer on top of itself. (The template Boot/Preloader/MainMenu/Game/GameOver scenes
// still live in ./scenes and can be re-registered here if a menu flow is wanted.)
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

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
});
