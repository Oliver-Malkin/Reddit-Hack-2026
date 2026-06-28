import { Scene, GameObjects } from "phaser";

class Node extends GameObjects.Container {
    static letter_w: number = 45
    static letter_h: number = 55
    static letter_gap: number = 4

    boxes: Array<GameObjects.Rectangle> = []

    constructor(scene: Scene, x: number, y: number, word: string) {
        super(scene, x, y, [])

        let width = word.length * Node.letter_w - (word.length-1) * Node.letter_gap
        this.add(new GameObjects.Rectangle(
            this.scene,
            0, 0, width, Node.letter_h,
            0x000000
        ))

        let bx = -width / 2
        for (let i = 0; i < word.length; i++) {
            let box = new GameObjects.Rectangle(
                this.scene,
                bx + Node.letter_w/2,
                0,
                Node.letter_w - 2 * Node.letter_gap,
                Node.letter_h - 2 * Node.letter_gap,
                0xffffff
            )

            this.boxes.push(box)

            bx += Node.letter_w - Node.letter_gap
        }

        this.add(this.boxes)

        for (let i = 0; i < word.length; i++) {
            let ch = word.charAt(i)

            this.add(new GameObjects.Text(
                this.scene,
                this.boxes[i].x, this.boxes[i].y, ch, {
                    fontSize: 30,
                    color: '#000077',
                    align: "center",
                    fontFamily: "Courier New",
                }
            ).setOrigin(0.5))
        }
    }
}

export class Game extends Scene {
    fishy: Node
    stinkypoo: Node

    constructor() {
        super("Game")
    }

    create() {
        this.fishy = this.add.existing(
            new Node(this, 400, 200, "fisher")
        )
        this.stinkypoo = this.add.existing(
            new Node(this, 500, 350, "fresh")
        )

        let cy = 500
        for (let row of ["QWERTYUIOP", "ASDFGHJKL⏎", "ZXCVBNM␡"]) {
            let cont = this.add.container(500, cy += 70)
            let gap = 80
            for (let i = 0; i < row.length; i++) {
                let ch = row.charAt(i)
                let ch_x = i * gap - (row.length - 1) * gap / 2

                const key_box = new GameObjects.Rectangle(
                    this,
                    ch_x, 0, 60, 60, 0xbbbbbb, 1
                )

                const glyph = new GameObjects.Text(
                    this,
                    ch_x, 0, ch, {
                        fontSize: 40,
                        color: '#fff',
                        align: "center",
                        fontFamily: "Comic Sans MS",
                        shadow: {
                            color: '#fff',
                            offsetX: 3,
                            offsetY: 3,
                        }
                    }
                ).setOrigin(0.5)

                this.input.keyboard?.on("keydown-" + ch, function () {
                    glyph.setColor('#ff0000')
                    glyph.setShadowFill(true)
                })

                this.input.keyboard?.on("keyup-" + ch, function () {
                    glyph.setColor('#fff')
                    glyph.setShadowFill(false)
                })

                cont.add(key_box)
                cont.add(glyph)
            }
        }
    }
}
