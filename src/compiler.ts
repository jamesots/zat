import * as ASM from 'asm80/asm';
import * as Monolith from 'asm80/monolith';

export class Compiler {
    private RAM = new Uint8Array(65536);

    public compile(code) {
        let vxx = ASM.compile(code, Monolith.Z80);

        if (vxx[0]) {
            throw vxx[0];
        }
        let vx = vxx[1];

        let outdata = ASM.hex(vx[0]);

        let prog = this.hex2bytes(outdata);

        return prog;
    }

    private hexLine(ln, offset) {
        var i;
        if (ln[0] !== ':') { return false; }
        var len = parseInt(ln[1] + ln[2], 16);
        var start = parseInt(ln[3] + ln[4] + ln[5] + ln[6], 16);
        var typ = parseInt(ln[7] + ln[8], 16);
        offset = offset || 0;
        var addrx;
        if (typ === 0) {
            for (i = 0; i < len; i++) {
                this.RAM[start + i + offset] = parseInt(ln[9 + 2 * i] + ln[10 + 2 * i], 16);
                addrx = start + i;
            }
        }
        return addrx;
    }

    private readHex(hex, offset) {
        var hexlines = hex.split(/\n/);
        var lastaddr = 0;
        for (var i = 0; i < hexlines.length; i++) {
            var lb = this.hexLine(hexlines[i], offset);
            if (lb > lastaddr) lastaddr = lb;
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