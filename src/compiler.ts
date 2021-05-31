import * as maz from 'maz/lib/compiler';
import * as els from 'maz/lib/els';
import * as fs from 'fs';

export class CompiledProg {
    public constructor(
        public data: Buffer,
        public symbols: { [symbol: string]: number },
        public list: string[],
        public ast: els.Element[],
        public sources: maz.Source[]
    ) {}

    public dumpList() {
        for (const line of this.list) {
            console.log(line);
        }
    }
}

export class Compiler {
    private RAM = new Uint8Array(65536);

    public compile(code): CompiledProg {
        const prog = maz.compile('code', {
            fileResolver: new maz.StringFileResolver('code', code.split('\n')),
        });
        // console.log(prog.symbols);
        return new CompiledProg(
            Buffer.from(prog.getBytes()), // wrong origin
            prog.symbols,
            prog.getList(false),
            prog.ast,
            prog.sources
        );
        // const [error, vx] = ASM.compile(code, Monolith.Z80);

        // if (error) {
        //     throw `${error.msg} (${error.s.numline}:${error.s.line})`;
        // }
        // // console.log(JSON.stringify(vx, undefined, 2));

        // const [parseTree, symbols] = vx;
        // const outdata = ASM.hex(parseTree);

        // const prog = this.hex2bytes(outdata);

        // return {
        //     data: prog,
        //     symbols: vx[1]
        // };
    }

    public compileFile(filename: string): CompiledProg {
        let buffer = fs.readFileSync(filename);
        return this.compile(buffer.toString());
    }

    private hexLine(ln, offset) {
        let i;
        if (ln[0] !== ':') {
            return false;
        }
        const len = parseInt(ln[1] + ln[2], 16);
        const start = parseInt(ln[3] + ln[4] + ln[5] + ln[6], 16);
        const typ = parseInt(ln[7] + ln[8], 16);
        offset = offset || 0;
        let addrx;
        if (typ === 0) {
            for (i = 0; i < len; i++) {
                this.RAM[start + i + offset] = parseInt(
                    ln[9 + 2 * i] + ln[10 + 2 * i],
                    16
                );
                addrx = start + i;
            }
        }
        return addrx;
    }

    private readHex(hex, offset) {
        const hexlines = hex.split(/\n/);
        let lastaddr = 0;
        for (let i = 0; i < hexlines.length; i++) {
            const lb = this.hexLine(hexlines[i], offset);
            if (lb > lastaddr) {
                lastaddr = lb;
            }
        }
        return lastaddr;
    }

    private hex2bytes(hex) {
        this.RAM = new Uint8Array(65536);
        const lastaddr = this.readHex(hex, 0) + 1;
        const out = this.RAM.subarray(0, lastaddr);
        return Buffer.from(out as any);
    }
}
