import { Scene, GameObjects } from "phaser";
import { words } from "../Words";

class Fish extends GameObjects.Text {
    static colours = [
        "#ccccff",
        "#cceecc",
        "#ffddaa",
    ]

    a: number
    b: number
    c: number

    constructor(scene: Scene, x: number, y: number) {
        let word = words[Math.floor(Math.random() * words.length)]
            .toLowerCase()

        super(scene, x, y, word, {
            fontSize: 15 + Math.random() * 30,
            color: Fish.colours[Math.floor(Math.random() * Fish.colours.length)],
            align: "center",
        })

        this.depth = -1
        this.addToUpdateList()
        this.active = true

        this.a = Math.random() + 0.2
        this.b = Math.random() + 1
        this.c = Math.random() * 2 - 1
        this.rotation += Math.random() - 0.5
    }

    preUpdate(time: number, delta: number): void {
        this.update(time, delta)

        this.rotation = this.a * Math.sin(this.c * time / 1000)
        this.x += Math.cos(this.rotation) * 100 * (delta / 1000)
        this.y += Math.sin(this.rotation) * (50 * this.b) * (delta / 1000)

        if (this.x > 1100) {
            this.destroy()
        }
    }
}

export class MainMenu extends Scene {
    letters: Array<GameObjects.Text> = []
    fishy: Fish

    constructor() {
        super("MainMenu");
    }

    makeFish() {
        this.add.existing(
            new Fish(
                this,
                -200, Math.random() * 1000 + -100
            ).setOrigin(0.5)
        )
    }

    create() {
        this.time.addEvent({
            delay: 250,
            callback: this.makeFish,
            callbackScope: this,
            loop: true
        })

        for (let i = 0; i < 100; i++) {
            this.add.existing(
                new Fish(
                    this,
                    Math.random() * 1200 - 100, Math.random() * 1000 + -100
                ).setOrigin(0.5)
            )
        }

        let title = "Wordfish"
        for (let i = 0; i < title.length; i++) {
            this.letters.push(this.add
                .text(512 + (0.5 + i - title.length/2) * 60, 300, title[i], {
                    fontSize: 80,
                    color: '#000000',
                    align: "center",
                })
                .setOrigin(0.5)
            )
        }

        this.input.once("pointerdown", () => {
            this.scene.start("Game");
        });
    }

    update(time: number, _delta: number): void {
        for (let i = 0; i < this.letters.length; i++) {
            let letter = this.letters[i]
            letter.y += 0.1 * Math.sin(
                Math.cos(i * i) * 3 * time / 1000 + 5 * i
            )
        }
    }
}
