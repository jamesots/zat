///////////////////////////////////////////////////////////////////////////////
/// @file Z80.js
///
/// @brief Emulator for the Zilog Z80 microprocessor
///
/// @author Matthew Howell
///
/// @remarks
///  This module is a simple, straightforward instruction interpreter.
///   There is no fancy dynamic recompilation or cycle-accurate emulation.
///   The author believes that this should be sufficient for any emulator that
///   would be feasible to write in JavaScript anyway.
///  The code and the comments in this file assume that the reader is familiar
///   with the Z80 architecture. If you're not, here are some references I use:
///  http://clrhome.org/table/ - Z80 instruction set tables
///  http://www.zilog.com/docs/z80/um0080.pdf - The official manual
///  http://www.myquest.nl/z80undocumented/z80-documented-v0.91.pdf
///   - The Undocumented Z80, Documented
///
/// @copyright (c) 2013 Matthew Howell
///  This code is released under the MIT license,
///  a copy of which is available in the associated README.md file,
///  or at http://opensource.org/licenses/MIT
///////////////////////////////////////////////////////////////////////////////
/// https://github.com/DrGoldfire/Z80.js
"use strict";

export interface Flags { 
    S: number,
    Z: number,
    Y: number,
    H: number,
    X: number,
    P: number,
    N: number,
    C: number }

///////////////////////////////////////////////////////////////////////////////
/// We'll begin with the object constructor and the private API functions.
///////////////////////////////////////////////////////////////////////////////
export class Z80 {
    // All right, let's initialize the registers.
    // First, the standard 8080 registers.
    public a = 0x00;
    public b = 0x00;
    public c = 0x00;
    public d = 0x00;
    public e = 0x00;
    public h = 0x00;
    public l = 0x00;
    // Now the special Z80 copies of the 8080 registers
    //  (the ones used for the SWAP instruction and such).
    public a_ = 0x00;
    public b_ = 0x00;
    public c_ = 0x00;
    public d_ = 0x00;
    public e_ = 0x00;
    public h_ = 0x00;
    public l_ = 0x00;
    // And now the Z80 index registers.
    public ix = 0x0000;
    public iy = 0x0000;
    // Then the "utility" registers: the interrupt vector,
    //  the memory refresh, the stack pointer, and the program counter.
    public i = 0x00;
    public r = 0x00;
    public sp = 0xdff0;
    public pc = 0x0000;
    // We don't keep an F register for the flags,
    //  because most of the time we're only accessing a single flag,
    //  so we optimize for that case and use utility functions
    //  for the rarer occasions when we need to access the whole register.
    public flags: Flags = { S: 0, Z: 0, Y: 0, H: 0, X: 0, P: 0, N: 0, C: 0 };
    public flags_: Flags = { S: 0, Z: 0, Y: 0, H: 0, X: 0, P: 0, N: 0, C: 0 };
    // And finally we have the interrupt mode and flip-flop registers.
    public imode = 0;
    public iff1 = 0;
    public iff2 = 0;

    // These are all specific to this implementation, not Z80 features.
    // Keep track of whether we've had a HALT instruction called.
    public halted = false;
    // EI and DI wait one instruction before they take effect;
    //  these flags tell us when we're in that wait state.
    private doDelayedDi = false;
    private doDelayedEi = false;
    // This tracks the number of cycles spent in a single instruction run,
    //  including processing any prefixes and handling interrupts.
    private cycleCounter = 0;

    constructor(private core: any) {
        // The argument to this constructor should be an object containing 4 functions:
        // memRead(address) should return the byte at the given memory address,
        // memWrite(address, value) should write the given value to the given memory address,
        // ioRead(port) should read a return a byte read from the given I/O port,
        // ioWrite(port, value) should write the given byte to the given I/O port.
        // If any of those functions is missing, this module cannot run.
        if (!core || (typeof core.memRead !== "function") || (typeof core.memWrite !== "function") ||
            (typeof core.ioRead !== "function") || (typeof core.ioWrite !== "function"))
            throw ("Z80: Core object is missing required functions.");

        // Obviously we'll be needing the core object's functions again.
        this.core = core;


        this.initializeInstructions();
        this.initializeEdInstructions();
        this.initializeDdInstructions();
    }

    ///////////////////////////////////////////////////////////////////////////////
    /// @public reset
    ///
    /// @brief Re-initialize the processor as if a reset or power on had occured
    ///////////////////////////////////////////////////////////////////////////////
    public reset() {
        // These registers are the ones that have predictable states
        //  immediately following a power-on or a reset.
        // The others are left alone, because their states are unpredictable.
        this.sp = 0xdff0;
        this.pc = 0x0000;
        this.a = 0x00;
        this.r = 0x00;
        this.setFlags(0);
        // Start up with interrupts disabled.
        this.imode = 0;
        this.iff1 = 0;
        this.iff2 = 0;
        // Don't start halted or in a delayed DI or EI.
        this.halted = false;
        this.doDelayedDi = false;
        this.doDelayedEi = false;
        // Obviously we've not used any cycles yet.
        this.cycleCounter = 0;
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// @public runInstruction
    ///
    /// @brief Runs a single instruction
    ///
    /// @return The number of T cycles the instruction took to run,
    ///          plus any time that went into handling interrupts that fired
    ///          while this instruction was executing
    ///////////////////////////////////////////////////////////////////////////////
    public runInstruction() {
        if (!this.halted) {
            // If the previous instruction was a DI or an EI,
            //  we'll need to disable or enable interrupts
            //  after whatever instruction we're about to run is finished.
            var doingDelayedDi = false, doingDelayedEi = false;
            if (this.doDelayedDi) {
                this.doDelayedDi = false;
                doingDelayedDi = true;
            }
            else if (this.doDelayedEi) {
                this.doDelayedEi = false;
                doingDelayedEi = true;
            }

            // R is incremented at the start of every instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            // Read the byte at the PC and run the instruction it encodes.
            var opcode = this.core.memRead(this.pc);
            this.decodeInstruction(opcode);
            this.pc = (this.pc + 1) & 0xffff;

            // Actually do the delayed interrupt disable/enable if we have one.
            if (doingDelayedDi) {
                this.iff1 = 0;
                this.iff2 = 0;
            }
            else if (doingDelayedEi) {
                this.iff1 = 1;
                this.iff2 = 1;
            }

            // And finally clear out the cycle counter for the next instruction
            //  before returning it to the emulator core.
            var retval = this.cycleCounter;
            this.cycleCounter = 0;
            return retval;
        }
        else {
            // While we're halted, claim that we spent a cycle doing nothing,
            //  so that the rest of the emulator can still proceed.
            return 1;
        }
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// @public interrupt
    ///
    /// @brief Simulates pulsing the processor's INT (or NMI) pin
    ///
    /// @param nonMaskable - true if this is a non-maskable interrupt
    /// @param data - the value to be placed on the data bus, if needed
    ///////////////////////////////////////////////////////////////////////////////
    public interrupt(nonMaskable, data) {
        if (nonMaskable) {
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);
            // Non-maskable interrupts are always handled the same way;
            //  clear IFF1 and then do a CALL 0x0066.
            // Also, all interrupts reset the HALT state.
            this.halted = false;
            this.iff2 = this.iff1;
            this.iff1 = 0;
            this.pushWord(this.pc);
            this.pc = 0x66;
            this.cycleCounter += 11;
        }
        else if (this.iff1) {
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.halted = false;
            this.iff1 = 0;
            this.iff2 = 0;

            if (this.imode === 0) {
                // In the 8080-compatible interrupt mode,
                //  decode the content of the data bus as an instruction and run it.
                this.decodeInstruction(data);
                this.cycleCounter += 2;
            }
            else if (this.imode === 1) {
                // Mode 1 is always just RST 0x38.
                this.pushWord(this.pc);
                this.pc = 0x38;
                this.cycleCounter += 13;
            }
            else if (this.imode === 2) {
                // Mode 2 uses the value on the data bus as in index
                //  into the vector table pointer to by the I register.
                this.pushWord(this.pc);
                // The Z80 manual says that this address must be 2-byte aligned,
                //  but it doesn't appear that this is actually the case on the hardware,
                //  so we don't attempt to enforce that here.
                var vectorAddress = ((this.i << 8) | data);
                this.pc = this.core.read_mem_byte(vectorAddress) |
                    (this.core.read_mem_byte((vectorAddress + 1) & 0xffff) << 8);

                this.cycleCounter += 19;
            }
        }
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// The private API functions end here.
    ///
    /// What begins here are just general utility functions, used variously.
    ///////////////////////////////////////////////////////////////////////////////
    private decodeInstruction(opcode) {
        // The register-to-register loads and ALU instructions
        //  are all so uniform that we can decode them directly
        //  instead of going into the instruction array for them.
        // This function gets the operand for all of these instructions.
        var getOperand = function (opcode) {
            return ((opcode & 0x07) === 0) ? this.b :
                ((opcode & 0x07) === 1) ? this.c :
                    ((opcode & 0x07) === 2) ? this.d :
                        ((opcode & 0x07) === 3) ? this.e :
                            ((opcode & 0x07) === 4) ? this.h :
                                ((opcode & 0x07) === 5) ? this.l :
                                    ((opcode & 0x07) === 6) ? this.core.memRead(this.l | (this.h << 8)) : this.a;
        };

        // Handle HALT right up front, because it fouls up our LD decoding
        //  by falling where LD (HL), (HL) ought to be.
        if (opcode === 0x76) {
            this.halted = true;
            this.iff1 = 1;
            this.iff2 = 1;
        }
        else if ((opcode >= 0x40) && (opcode < 0x80)) {
            // This entire range is all 8-bit register loads.
            // Get the operand and assign it to the correct destination.
            var operand = getOperand.call(this, opcode);

            if (((opcode & 0x38) >>> 3) === 0)
                this.b = operand;
            else if (((opcode & 0x38) >>> 3) === 1)
                this.c = operand;
            else if (((opcode & 0x38) >>> 3) === 2)
                this.d = operand;
            else if (((opcode & 0x38) >>> 3) === 3)
                this.e = operand;
            else if (((opcode & 0x38) >>> 3) === 4)
                this.h = operand;
            else if (((opcode & 0x38) >>> 3) === 5)
                this.l = operand;
            else if (((opcode & 0x38) >>> 3) === 6)
                this.core.memWrite(this.l | (this.h << 8), operand);
            else if (((opcode & 0x38) >>> 3) === 7)
                this.a = operand;
        }
        else if ((opcode >= 0x80) && (opcode < 0xc0)) {
            // These are the 8-bit register ALU instructions.
            // We'll get the operand and then use this "jump table"
            //  to call the correct utility function for the instruction.
            var operand = getOperand.call(this, opcode),
                opArray = [this.doAdd, this.doAdc, this.doSub, this.doSbc,
                this.doAnd, this.doXor, this.doOr, this.doCp];

            opArray[(opcode & 0x38) >>> 3].call(this, operand);
        }
        else {
            // This is one of the less formulaic instructions;
            //  we'll get the specific function for it from our array.
            this.instructions[opcode]();
        }

        // Update the cycle counter with however many cycles
        //  the base instruction took.
        // If this was a prefixed instruction, then
        //  the prefix handler has added its extra cycles already.
        this.cycleCounter += this.cycleCounts[opcode];
    };

    private getSignedOffsetByte(value) {
        // This function requires some explanation.
        // We just use JavaScript Number variables for our registers,
        //  not like a typed array or anything.
        // That means that, when we have a byte value that's supposed
        //  to represent a signed offset, the value we actually see
        //  isn't signed at all, it's just a small integer.
        // So, this function converts that byte into something JavaScript
        //  will recognize as signed, so we can easily do arithmetic with it.
        // First, we clamp the value to a single byte, just in case.
        value &= 0xff;
        // We don't have to do anything if the value is positive.
        if (value & 0x80) {
            // But if the value is negative, we need to manually un-two's-compliment it.
            // I'm going to assume you can figure out what I meant by that,
            //  because I don't know how else to explain it.
            // We could also just do value |= 0xffffff00, but I prefer
            //  not caring how many bits are in the integer representation
            //  of a JavaScript number in the currently running browser.
            value = -((0xff & ~value) + 1);
        }
        return value;
    };

    private getFlags() {
        // We need the whole F register for some reason.
        //  probably a PUSH AF instruction,
        //  so make the F register out of our separate flags.
        return (this.flags.S << 7) |
            (this.flags.Z << 6) |
            (this.flags.Y << 5) |
            (this.flags.H << 4) |
            (this.flags.X << 3) |
            (this.flags.P << 2) |
            (this.flags.N << 1) |
            (this.flags.C);
    };

    private getFlags_() {
        // This is the same as the above for the F' register.
        return (this.flags_.S << 7) |
            (this.flags_.Z << 6) |
            (this.flags_.Y << 5) |
            (this.flags_.H << 4) |
            (this.flags_.X << 3) |
            (this.flags_.P << 2) |
            (this.flags_.N << 1) |
            (this.flags_.C);
    };

    private setFlags(operand) {
        // We need to set the F register, probably for a POP AF,
        //  so break out the given value into our separate flags.
        this.flags.S = (operand & 0x80) >>> 7;
        this.flags.Z = (operand & 0x40) >>> 6;
        this.flags.Y = (operand & 0x20) >>> 5;
        this.flags.H = (operand & 0x10) >>> 4;
        this.flags.X = (operand & 0x08) >>> 3;
        this.flags.P = (operand & 0x04) >>> 2;
        this.flags.N = (operand & 0x02) >>> 1;
        this.flags.C = (operand & 0x01);
    };

    private setFlags_(operand) {
        // Again, this is the same as the above for F'.
        this.flags_.S = (operand & 0x80) >>> 7;
        this.flags_.Z = (operand & 0x40) >>> 6;
        this.flags_.Y = (operand & 0x20) >>> 5;
        this.flags_.H = (operand & 0x10) >>> 4;
        this.flags_.X = (operand & 0x08) >>> 3;
        this.flags_.P = (operand & 0x04) >>> 2;
        this.flags_.N = (operand & 0x02) >>> 1;
        this.flags_.C = (operand & 0x01);
    };

    private updateXyFlags(result) {
        // Most of the time, the undocumented flags
        //  (sometimes called X and Y, or 3 and 5),
        //  take their values from the corresponding bits
        //  of the result of the instruction,
        //  or from some other related value.
        // This is a utility function to set those flags based on those bits.
        this.flags.Y = (result & 0x20) >>> 5;
        this.flags.X = (result & 0x08) >>> 3;
    };

    private getParity(value) {
        // We could try to actually calculate the parity every time,
        //  but why calculate what you can pre-calculate?
        var parityBits = [
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
            1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1
        ];
        return parityBits[value];
    };

    private pushWord(operand) {
        // Pretty obvious what this function does; given a 16-bit value,
        //  decrement the stack pointer, write the high byte to the new
        //  stack pointer location, then repeat for the low byte.
        this.sp = (this.sp - 1) & 0xffff;
        this.core.memWrite(this.sp, (operand & 0xff00) >>> 8);
        this.sp = (this.sp - 1) & 0xffff;
        this.core.memWrite(this.sp, operand & 0x00ff);
    };

    private popWord() {
        // Again, not complicated; read a byte off the top of the stack,
        //  increment the stack pointer, rinse and repeat.
        var retval = this.core.memRead(this.sp) & 0xff;
        this.sp = (this.sp + 1) & 0xffff;
        retval |= this.core.memRead(this.sp) << 8;
        this.sp = (this.sp + 1) & 0xffff;
        return retval;
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// Now, the way most instructions work in this emulator is that they set up
    ///  their operands according to their addressing mode, and then they call a
    ///  utility function that handles all variations of that instruction.
    /// Those utility functions begin here.
    ///////////////////////////////////////////////////////////////////////////////
    private doConditionalAbsoluteJump(condition) {
        // This function implements the JP [condition],nn instructions.
        if (condition) {
            // We're taking this jump, so write the new PC,
            //  and then decrement the thing we just wrote,
            //  because the instruction decoder increments the PC
            //  unconditionally at the end of every instruction
            //  and we need to counteract that so we end up at the jump target.
            this.pc = this.core.memRead((this.pc + 1) & 0xffff) |
                (this.core.memRead((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        }
        else {
            // We're not taking this jump, just move the PC past the operand.
            this.pc = (this.pc + 2) & 0xffff;
        }
    };

    private doConditionalRelativeJump(condition) {
        // This function implements the JR [condition],n instructions.
        if (condition) {
            // We need a few more cycles to actually take the jump.
            this.cycleCounter += 5;
            // Calculate the offset specified by our operand.
            var offset = this.getSignedOffsetByte(this.core.memRead((this.pc + 1) & 0xffff));
            // Add the offset to the PC, also skipping past this instruction.
            this.pc = (this.pc + offset + 1) & 0xffff;
        }
        else {
            // No jump happening, just skip the operand.
            this.pc = (this.pc + 1) & 0xffff;
        }
    };

    private doConditionalCall(condition) {
        // This function is the CALL [condition],nn instructions.
        // If you've seen the previous functions, you know this drill.
        if (condition) {
            this.cycleCounter += 7;
            this.pushWord((this.pc + 3) & 0xffff);
            this.pc = this.core.memRead((this.pc + 1) & 0xffff) |
                (this.core.memRead((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        }
        else {
            this.pc = (this.pc + 2) & 0xffff;
        }
    };

    private doConditionalReturn(condition) {
        if (condition) {
            this.cycleCounter += 6;
            this.pc = (this.popWord() - 1) & 0xffff;
        }
    };

    private doReset(address) {
        // The RST [address] instructions go through here.
        this.pushWord((this.pc + 1) & 0xffff);
        this.pc = (address - 1) & 0xffff;
    };

    private doAdd(operand) {
        // This is the ADD A, [operand] instructions.
        // We'll do the literal addition, which includes any overflow,
        //  so that we can more easily figure out whether we had
        //  an overflow or a carry and set the flags accordingly.
        var result = this.a + operand;

        // The great majority of the work for the arithmetic instructions
        //  turns out to be setting the flags rather than the actual operation.
        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((operand & 0x0f) + (this.a & 0x0f)) & 0x10) ? 1 : 0;
        // An overflow has happened if the sign bits of the accumulator and the operand
        //  don't match the sign bit of the result value.
        this.flags.P = ((this.a & 0x80) === (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 0;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.updateXyFlags(this.a);
    };

    private doAdc(operand) {
        var result = this.a + operand + this.flags.C;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((operand & 0x0f) + (this.a & 0x0f) + this.flags.C) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) === (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 0;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.updateXyFlags(this.a);
    };

    private doSub(operand) {
        var result = this.a - operand;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((this.a & 0x0f) - (operand & 0x0f)) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) !== (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.updateXyFlags(this.a);
    };

    private doSbc(operand) {
        var result = this.a - operand - this.flags.C;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((this.a & 0x0f) - (operand & 0x0f) - this.flags.C) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) !== (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.updateXyFlags(this.a);
    };

    private doCp(operand) {
        // A compare instruction is just a subtraction that doesn't save the value,
        //  so we implement it as... a subtraction that doesn't save the value.
        var temp = this.a;
        this.doSub(operand);
        this.a = temp;
        // Since this instruction has no "result" value, the undocumented flags
        //  are set based on the operand instead.
        this.updateXyFlags(operand);
    };

    private doAnd(operand) {
        // The logic instructions are all pretty straightforward.
        this.a &= operand & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 1;
        this.flags.P = this.getParity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.updateXyFlags(this.a);
    };

    private doOr(operand) {
        this.a = (operand | this.a) & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 0;
        this.flags.P = this.getParity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.updateXyFlags(this.a);
    };

    private doXor(operand) {
        this.a = (operand ^ this.a) & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 0;
        this.flags.P = this.getParity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.updateXyFlags(this.a);
    };

    private doInc(operand) {
        var result = operand + 1;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = ((operand & 0x0f) === 0x0f) ? 1 : 0;
        // It's a good deal easier to detect overflow for an increment/decrement.
        this.flags.P = (operand === 0x7f) ? 1 : 0;
        this.flags.N = 0;

        result &= 0xff;
        this.updateXyFlags(result);

        return result;
    };

    private doDec(operand) {
        var result = operand - 1;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = ((operand & 0x0f) === 0x00) ? 1 : 0;
        this.flags.P = (operand === 0x80) ? 1 : 0;
        this.flags.N = 1;

        result &= 0xff;
        this.updateXyFlags(result);

        return result;
    };

    private doHlAdd(operand) {
        // The HL arithmetic instructions are the same as the A ones,
        //  just with twice as many bits happening.
        var hl = this.l | (this.h << 8), result = hl + operand;

        this.flags.N = 0;
        this.flags.C = (result & 0x10000) ? 1 : 0;
        this.flags.H = (((hl & 0x0fff) + (operand & 0x0fff)) & 0x1000) ? 1 : 0;

        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.updateXyFlags(this.h);
    };

    private doHlAdc(operand) {
        operand += this.flags.C;
        var hl = this.l | (this.h << 8), result = hl + operand;

        this.flags.S = (result & 0x8000) ? 1 : 0;
        this.flags.Z = !(result & 0xffff) ? 1 : 0;
        this.flags.H = (((hl & 0x0fff) + (operand & 0x0fff)) & 0x1000) ? 1 : 0;
        this.flags.P = ((hl & 0x8000) === (operand & 0x8000)) && ((result & 0x8000) !== (hl & 0x8000)) ? 1 : 0;
        this.flags.N = 0;
        this.flags.C = (result & 0x10000) ? 1 : 0;

        this.l = result & 0xff;
        this.h = (result >>> 8) & 0xff;

        this.updateXyFlags(this.h);
    };

    private doHlSbc(operand) {
        operand += this.flags.C;
        var hl = this.l | (this.h << 8), result = hl - operand;

        this.flags.S = (result & 0x8000) ? 1 : 0;
        this.flags.Z = !(result & 0xffff) ? 1 : 0;
        this.flags.H = (((hl & 0x0fff) - (operand & 0x0fff)) & 0x1000) ? 1 : 0;
        this.flags.P = ((hl & 0x8000) !== (operand & 0x8000)) && ((result & 0x8000) !== (hl & 0x8000)) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = (result & 0x10000) ? 1 : 0;

        this.l = result & 0xff;
        this.h = (result >>> 8) & 0xff;

        this.updateXyFlags(this.h);
    };

    private doIn(port) {
        var result = this.core.ioRead(port);

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = result ? 0 : 1;
        this.flags.H = 0;
        this.flags.P = this.getParity(result) ? 1 : 0;
        this.flags.N = 0;
        this.updateXyFlags(result);

        return result;
    };

    private doNeg() {
        // This instruction is defined to not alter the register if it === 0x80.
        if (this.a !== 0x80) {
            // This is a signed operation, so convert A to a signed value.
            this.a = this.getSignedOffsetByte(this.a);

            this.a = (-this.a) & 0xff;
        }

        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = (((-this.a) & 0x0f) > 0) ? 1 : 0;
        this.flags.P = (this.a === 0x80) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = this.a ? 1 : 0;
        this.updateXyFlags(this.a);
    };

    private doLdi() {
        // Copy the value that we're supposed to copy.
        var readValue = this.core.memRead(this.l | (this.h << 8));
        this.core.memWrite(this.e | (this.d << 8), readValue);

        // Increment DE and HL, and decrement BC.
        var result = (this.e | (this.d << 8)) + 1;
        this.e = result & 0xff;
        this.d = (result & 0xff00) >>> 8;
        result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.H = 0;
        this.flags.P = (this.c || this.b) ? 1 : 0;
        this.flags.N = 0;
        this.flags.Y = ((this.a + readValue) & 0x02) >>> 1;
        this.flags.X = ((this.a + readValue) & 0x08) >>> 3;
    };

    private doCpi() {
        var tempCarry = this.flags.C;
        var readValue = this.core.memRead(this.l | (this.h << 8))
        this.doCp(readValue);
        this.flags.C = tempCarry;
        this.flags.Y = ((this.a - readValue - this.flags.H) & 0x02) >>> 1;
        this.flags.X = ((this.a - readValue - this.flags.H) & 0x08) >>> 3;

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.P = result ? 1 : 0;
    };

    private doIni() {
        this.b = this.doDec(this.b);

        this.core.memWrite(this.l | (this.h << 8), this.core.ioRead((this.b << 8) | this.c));

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.flags.N = 1;
    };

    private doOuti() {
        this.core.ioWrite((this.b << 8) | this.c, this.core.memRead(this.l | (this.h << 8)));

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.b = this.doDec(this.b);
        this.flags.N = 1;
    };

    private doLdd() {
        this.flags.N = 0;
        this.flags.H = 0;

        var readValue = this.core.memRead(this.l | (this.h << 8));
        this.core.memWrite(this.e | (this.d << 8), readValue);

        var result = (this.e | (this.d << 8)) - 1;
        this.e = result & 0xff;
        this.d = (result & 0xff00) >>> 8;
        result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.P = (this.c || this.b) ? 1 : 0;
        this.flags.Y = ((this.a + readValue) & 0x02) >>> 1;
        this.flags.X = ((this.a + readValue) & 0x08) >>> 3;
    };

    private doCpd() {
        var tempCarry = this.flags.C
        var readValue = this.core.memRead(this.l | (this.h << 8))
        this.doCp(readValue);
        this.flags.C = tempCarry;
        this.flags.Y = ((this.a - readValue - this.flags.H) & 0x02) >>> 1;
        this.flags.X = ((this.a - readValue - this.flags.H) & 0x08) >>> 3;

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.P = result ? 1 : 0;
    };

    private doInd() {
        this.b = this.doDec(this.b);

        this.core.memWrite(this.l | (this.h << 8), this.core.ioRead((this.b << 8) | this.c));

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.flags.N = 1;
    };

    private doOutd() {
        this.core.ioWrite((this.b << 8) | this.c, this.core.memRead(this.l | (this.h << 8)));

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.b = this.doDec(this.b);
        this.flags.N = 1;
    };

    private doRlc(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) | this.flags.C) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doRrc(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (this.flags.C << 7);

        this.flags.Z = !(operand & 0xff) ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand & 0xff;
    };

    private doRl(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        var temp = this.flags.C;
        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) | temp) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doRr(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        var temp = this.flags.C;
        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (temp << 7);

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doSla(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = (operand << 1) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doSra(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (operand & 0x80);

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doSll(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) & 0xff) | 1;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doSrl(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = (operand >>> 1) & 0x7f;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.getParity(operand);
        this.flags.S = 0;
        this.updateXyFlags(operand);

        return operand;
    };

    private doIxAdd(operand) {
        this.flags.N = 0;

        var result = this.ix + operand;

        this.flags.C = (result & 0x10000) ? 1 : 0;
        this.flags.H = (((this.ix & 0xfff) + (operand & 0xfff)) & 0x1000) ? 1 : 0;
        this.updateXyFlags((result & 0xff00) >>> 8);

        this.ix = result;
    };


    ///////////////////////////////////////////////////////////////////////////////
    /// This table contains the implementations for the instructions that weren't
    ///  implemented directly in the decoder function (everything but the 8-bit
    ///  register loads and the accumulator ALU instructions, in other words).
    /// Similar tables for the ED and DD/FD prefixes follow this one.
    ///////////////////////////////////////////////////////////////////////////////
    private instructions = [];

    private initializeInstructions() {
        // 0x00 : NOP
        this.instructions[0x00] = () => { };
        // 0x01 : LD BC, nn
        this.instructions[0x01] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.c = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.b = this.core.memRead(this.pc);
        };
        // 0x02 : LD (BC), A
        this.instructions[0x02] = () => {
            this.core.memWrite(this.c | (this.b << 8), this.a);
        };
        // 0x03 : INC BC
        this.instructions[0x03] = () => {
            var result = (this.c | (this.b << 8));
            result += 1;
            this.c = result & 0xff;
            this.b = (result & 0xff00) >>> 8;
        };
        // 0x04 : INC B
        this.instructions[0x04] = () => {
            this.b = this.doInc(this.b);
        };
        // 0x05 : DEC B
        this.instructions[0x05] = () => {
            this.b = this.doDec(this.b);
        };
        // 0x06 : LD B, n
        this.instructions[0x06] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.b = this.core.memRead(this.pc);
        };
        // 0x07 : RLCA
        this.instructions[0x07] = () => {
            // This instruction is implemented as a special case of the
            //  more general Z80-specific RLC instruction.
            // Specifially, RLCA is a version of RLC A that affects fewer flags.
            // The same applies to RRCA, RLA, and RRA.
            var tempS = this.flags.S, tempZ = this.flags.Z, tempP = this.flags.P;
            this.a = this.doRlc(this.a);
            this.flags.S = tempS;
            this.flags.Z = tempZ;
            this.flags.P = tempP;
        };
        // 0x08 : EX AF, AF'
        this.instructions[0x08] = () => {
            var temp = this.a;
            this.a = this.a_;
            this.a_ = temp;

            temp = this.getFlags();
            this.setFlags(this.getFlags_());
            this.setFlags_(temp);
        };
        // 0x09 : ADD HL, BC
        this.instructions[0x09] = () => {
            this.doHlAdd(this.c | (this.b << 8));
        };
        // 0x0a : LD A, (BC)
        this.instructions[0x0a] = () => {
            this.a = this.core.memRead(this.c | (this.b << 8));
        };
        // 0x0b : DEC BC
        this.instructions[0x0b] = () => {
            var result = (this.c | (this.b << 8));
            result -= 1;
            this.c = result & 0xff;
            this.b = (result & 0xff00) >>> 8;
        };
        // 0x0c : INC C
        this.instructions[0x0c] = () => {
            this.c = this.doInc(this.c);
        };
        // 0x0d : DEC C
        this.instructions[0x0d] = () => {
            this.c = this.doDec(this.c);
        };
        // 0x0e : LD C, n
        this.instructions[0x0e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.c = this.core.memRead(this.pc);
        };
        // 0x0f : RRCA
        this.instructions[0x0f] = () => {
            var tempS = this.flags.S, tempZ = this.flags.Z, tempP = this.flags.P;
            this.a = this.doRrc(this.a);
            this.flags.S = tempS;
            this.flags.Z = tempZ;
            this.flags.P = tempP;
        };
        // 0x10 : DJNZ nn
        this.instructions[0x10] = () => {
            this.b = (this.b - 1) & 0xff;
            this.doConditionalRelativeJump(this.b !== 0);
        };
        // 0x11 : LD DE, nn
        this.instructions[0x11] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.e = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.d = this.core.memRead(this.pc);
        };
        // 0x12 : LD (DE), A
        this.instructions[0x12] = () => {
            this.core.memWrite(this.e | (this.d << 8), this.a);
        };
        // 0x13 : INC DE
        this.instructions[0x13] = () => {
            var result = (this.e | (this.d << 8));
            result += 1;
            this.e = result & 0xff;
            this.d = (result & 0xff00) >>> 8;
        };
        // 0x14 : INC D
        this.instructions[0x14] = () => {
            this.d = this.doInc(this.d);
        };
        // 0x15 : DEC D
        this.instructions[0x15] = () => {
            this.d = this.doDec(this.d);
        };
        // 0x16 : LD D, n
        this.instructions[0x16] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.d = this.core.memRead(this.pc);
        };
        // 0x17 : RLA
        this.instructions[0x17] = () => {
            var tempS = this.flags.S, tempZ = this.flags.Z, tempP = this.flags.P;
            this.a = this.doRl(this.a);
            this.flags.S = tempS;
            this.flags.Z = tempZ;
            this.flags.P = tempP;
        };
        // 0x18 : JR n
        this.instructions[0x18] = () => {
            var offset = this.getSignedOffsetByte(this.core.memRead((this.pc + 1) & 0xffff));
            this.pc = (this.pc + offset + 1) & 0xffff;
        };
        // 0x19 : ADD HL, DE
        this.instructions[0x19] = () => {
            this.doHlAdd(this.e | (this.d << 8));
        };
        // 0x1a : LD A, (DE)
        this.instructions[0x1a] = () => {
            this.a = this.core.memRead(this.e | (this.d << 8));
        };
        // 0x1b : DEC DE
        this.instructions[0x1b] = () => {
            var result = (this.e | (this.d << 8));
            result -= 1;
            this.e = result & 0xff;
            this.d = (result & 0xff00) >>> 8;
        };
        // 0x1c : INC E
        this.instructions[0x1c] = () => {
            this.e = this.doInc(this.e);
        };
        // 0x1d : DEC E
        this.instructions[0x1d] = () => {
            this.e = this.doDec(this.e);
        };
        // 0x1e : LD E, n
        this.instructions[0x1e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.e = this.core.memRead(this.pc);
        };
        // 0x1f : RRA
        this.instructions[0x1f] = () => {
            var tempS = this.flags.S, tempZ = this.flags.Z, tempP = this.flags.P;
            this.a = this.doRr(this.a);
            this.flags.S = tempS;
            this.flags.Z = tempZ;
            this.flags.P = tempP;
        };
        // 0x20 : JR NZ, n
        this.instructions[0x20] = () => {
            this.doConditionalRelativeJump(!this.flags.Z);
        };
        // 0x21 : LD HL, nn
        this.instructions[0x21] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.l = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.h = this.core.memRead(this.pc);
        };
        // 0x22 : LD (nn), HL
        this.instructions[0x22] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.l);
            this.core.memWrite((address + 1) & 0xffff, this.h);
        };
        // 0x23 : INC HL
        this.instructions[0x23] = () => {
            var result = (this.l | (this.h << 8));
            result += 1;
            this.l = result & 0xff;
            this.h = (result & 0xff00) >>> 8;
        };
        // 0x24 : INC H
        this.instructions[0x24] = () => {
            this.h = this.doInc(this.h);
        };
        // 0x25 : DEC H
        this.instructions[0x25] = () => {
            this.h = this.doDec(this.h);
        };
        // 0x26 : LD H, n
        this.instructions[0x26] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.h = this.core.memRead(this.pc);
        };
        // 0x27 : DAA
        this.instructions[0x27] = () => {
            var temp = this.a;
            if (!this.flags.N) {
                if (this.flags.H || ((this.a & 0x0f) > 9))
                    temp += 0x06;
                if (this.flags.C || (this.a > 0x99))
                    temp += 0x60;
            }
            else {
                if (this.flags.H || ((this.a & 0x0f) > 9))
                    temp -= 0x06;
                if (this.flags.C || (this.a > 0x99))
                    temp -= 0x60;
            }

            this.flags.S = (temp & 0x80) ? 1 : 0;
            this.flags.Z = !(temp & 0xff) ? 1 : 0;
            this.flags.H = ((this.a & 0x10) ^ (temp & 0x10)) ? 1 : 0;
            this.flags.P = this.getParity(temp & 0xff);
            // DAA never clears the carry flag if it was already set,
            //  but it is able to set the carry flag if it was clear.
            // Don't ask me, I don't know.
            // Note also that we check for a BCD carry, instead of the usual.
            this.flags.C = (this.flags.C || (this.a > 0x99)) ? 1 : 0;

            this.a = temp & 0xff;

            this.updateXyFlags(this.a);
        };
        // 0x28 : JR Z, n
        this.instructions[0x28] = () => {
            this.doConditionalRelativeJump(!!this.flags.Z);
        };
        // 0x29 : ADD HL, HL
        this.instructions[0x29] = () => {
            this.doHlAdd(this.l | (this.h << 8));
        };
        // 0x2a : LD HL, (nn)
        this.instructions[0x2a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.l = this.core.memRead(address);
            this.h = this.core.memRead((address + 1) & 0xffff);
        };
        // 0x2b : DEC HL
        this.instructions[0x2b] = () => {
            var result = (this.l | (this.h << 8));
            result -= 1;
            this.l = result & 0xff;
            this.h = (result & 0xff00) >>> 8;
        };
        // 0x2c : INC L
        this.instructions[0x2c] = () => {
            this.l = this.doInc(this.l);
        };
        // 0x2d : DEC L
        this.instructions[0x2d] = () => {
            this.l = this.doDec(this.l);
        };
        // 0x2e : LD L, n
        this.instructions[0x2e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.l = this.core.memRead(this.pc);
        };
        // 0x2f : CPL
        this.instructions[0x2f] = () => {
            this.a = (~this.a) & 0xff;
            this.flags.N = 1;
            this.flags.H = 1;
            this.updateXyFlags(this.a);
        };
        // 0x30 : JR NC, n
        this.instructions[0x30] = () => {
            this.doConditionalRelativeJump(!this.flags.C);
        };
        // 0x31 : LD SP, nn
        this.instructions[0x31] = () => {
            this.sp = this.core.memRead((this.pc + 1) & 0xffff) |
                (this.core.memRead((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc + 2) & 0xffff;
        };
        // 0x32 : LD (nn), A
        this.instructions[0x32] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.a);
        };
        // 0x33 : INC SP
        this.instructions[0x33] = () => {
            this.sp = (this.sp + 1) & 0xffff;
        };
        // 0x34 : INC (HL)
        this.instructions[0x34] = () => {
            var address = this.l | (this.h << 8);
            this.core.memWrite(address, this.doInc(this.core.memRead(address)));
        };
        // 0x35 : DEC (HL)
        this.instructions[0x35] = () => {
            var address = this.l | (this.h << 8);
            this.core.memWrite(address, this.doDec(this.core.memRead(address)));
        };
        // 0x36 : LD (HL), n
        this.instructions[0x36] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.core.memWrite(this.l | (this.h << 8), this.core.memRead(this.pc));
        };
        // 0x37 : SCF
        this.instructions[0x37] = () => {
            this.flags.N = 0;
            this.flags.H = 0;
            this.flags.C = 1;
            this.updateXyFlags(this.a);
        };
        // 0x38 : JR C, n
        this.instructions[0x38] = () => {
            this.doConditionalRelativeJump(!!this.flags.C);
        };
        // 0x39 : ADD HL, SP
        this.instructions[0x39] = () => {
            this.doHlAdd(this.sp);
        };
        // 0x3a : LD A, (nn)
        this.instructions[0x3a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.a = this.core.memRead(address);
        };
        // 0x3b : DEC SP
        this.instructions[0x3b] = () => {
            this.sp = (this.sp - 1) & 0xffff;
        };
        // 0x3c : INC A
        this.instructions[0x3c] = () => {
            this.a = this.doInc(this.a);
        };
        // 0x3d : DEC A
        this.instructions[0x3d] = () => {
            this.a = this.doDec(this.a);
        };
        // 0x3e : LD A, n
        this.instructions[0x3e] = () => {
            this.a = this.core.memRead((this.pc + 1) & 0xffff);
            this.pc = (this.pc + 1) & 0xffff;
        };
        // 0x3f : CCF
        this.instructions[0x3f] = () => {
            this.flags.N = 0;
            this.flags.H = this.flags.C;
            this.flags.C = this.flags.C ? 0 : 1;
            this.updateXyFlags(this.a);
        };
        // 0xc0 : RET NZ
        this.instructions[0xc0] = () => {
            this.doConditionalReturn(!this.flags.Z);
        };
        // 0xc1 : POP BC
        this.instructions[0xc1] = () => {
            var result = this.popWord();
            this.c = result & 0xff;
            this.b = (result & 0xff00) >>> 8;
        };
        // 0xc2 : JP NZ, nn
        this.instructions[0xc2] = () => {
            this.doConditionalAbsoluteJump(!this.flags.Z);
        };
        // 0xc3 : JP nn
        this.instructions[0xc3] = () => {
            this.pc = this.core.memRead((this.pc + 1) & 0xffff) |
                (this.core.memRead((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xc4 : CALL NZ, nn
        this.instructions[0xc4] = () => {
            this.doConditionalCall(!this.flags.Z);
        };
        // 0xc5 : PUSH BC
        this.instructions[0xc5] = () => {
            this.pushWord(this.c | (this.b << 8));
        };
        // 0xc6 : ADD A, n
        this.instructions[0xc6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doAdd(this.core.memRead(this.pc));
        };
        // 0xc7 : RST 00h
        this.instructions[0xc7] = () => {
            this.doReset(0x00);
        };
        // 0xc8 : RET Z
        this.instructions[0xc8] = () => {
            this.doConditionalReturn(!!this.flags.Z);
        };
        // 0xc9 : RET
        this.instructions[0xc9] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
        };
        // 0xca : JP Z, nn
        this.instructions[0xca] = () => {
            this.doConditionalAbsoluteJump(!!this.flags.Z);
        };
        // 0xcb : CB Prefix
        this.instructions[0xcb] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            // We don't have a table for this prefix,
            //  the instructions are all so uniform that we can directly decode them.
            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.memRead(this.pc),
                bitNumber = (opcode & 0x38) >>> 3,
                regCode = opcode & 0x07;

            if (opcode < 0x40) {
                // Shift/rotate instructions
                var opArray = [this.doRlc, this.doRrc, this.doRl, this.doRr,
                this.doSla, this.doSra, this.doSll, this.doSrl];

                if (regCode === 0)
                    this.b = opArray[bitNumber].call(this, this.b);
                else if (regCode === 1)
                    this.c = opArray[bitNumber].call(this, this.c);
                else if (regCode === 2)
                    this.d = opArray[bitNumber].call(this, this.d);
                else if (regCode === 3)
                    this.e = opArray[bitNumber].call(this, this.e);
                else if (regCode === 4)
                    this.h = opArray[bitNumber].call(this, this.h);
                else if (regCode === 5)
                    this.l = opArray[bitNumber].call(this, this.l);
                else if (regCode === 6)
                    this.core.memWrite(this.l | (this.h << 8),
                        opArray[bitNumber].call(this, this.core.memRead(this.l | (this.h << 8))));
                else if (regCode === 7)
                    this.a = opArray[bitNumber].call(this, this.a);
            }
            else if (opcode < 0x80) {
                // BIT instructions
                if (regCode === 0)
                    this.flags.Z = !(this.b & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 1)
                    this.flags.Z = !(this.c & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 2)
                    this.flags.Z = !(this.d & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 3)
                    this.flags.Z = !(this.e & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 4)
                    this.flags.Z = !(this.h & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 5)
                    this.flags.Z = !(this.l & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 6)
                    this.flags.Z = !((this.core.memRead(this.l | (this.h << 8))) & (1 << bitNumber)) ? 1 : 0;
                else if (regCode === 7)
                    this.flags.Z = !(this.a & (1 << bitNumber)) ? 1 : 0;

                this.flags.N = 0;
                this.flags.H = 1;
                this.flags.P = this.flags.Z;
                this.flags.S = ((bitNumber === 7) && !this.flags.Z) ? 1 : 0;
                // For the BIT n, (HL) instruction, the X and Y flags are obtained
                //  from what is apparently an internal temporary register used for
                //  some of the 16-bit arithmetic instructions.
                // I haven't implemented that register here,
                //  so for now we'll set X and Y the same way for every BIT opcode,
                //  which means that they will usually be wrong for BIT n, (HL).
                this.flags.Y = ((bitNumber === 5) && !this.flags.Z) ? 1 : 0;
                this.flags.X = ((bitNumber === 3) && !this.flags.Z) ? 1 : 0;
            }
            else if (opcode < 0xc0) {
                // RES instructions
                if (regCode === 0)
                    this.b &= (0xff & ~(1 << bitNumber));
                else if (regCode === 1)
                    this.c &= (0xff & ~(1 << bitNumber));
                else if (regCode === 2)
                    this.d &= (0xff & ~(1 << bitNumber));
                else if (regCode === 3)
                    this.e &= (0xff & ~(1 << bitNumber));
                else if (regCode === 4)
                    this.h &= (0xff & ~(1 << bitNumber));
                else if (regCode === 5)
                    this.l &= (0xff & ~(1 << bitNumber));
                else if (regCode === 6)
                    this.core.memWrite(this.l | (this.h << 8),
                        this.core.memRead(this.l | (this.h << 8)) & ~(1 << bitNumber));
                else if (regCode === 7)
                    this.a &= (0xff & ~(1 << bitNumber));
            }
            else {
                // SET instructions
                if (regCode === 0)
                    this.b |= (1 << bitNumber);
                else if (regCode === 1)
                    this.c |= (1 << bitNumber);
                else if (regCode === 2)
                    this.d |= (1 << bitNumber);
                else if (regCode === 3)
                    this.e |= (1 << bitNumber);
                else if (regCode === 4)
                    this.h |= (1 << bitNumber);
                else if (regCode === 5)
                    this.l |= (1 << bitNumber);
                else if (regCode === 6)
                    this.core.memWrite(this.l | (this.h << 8),
                        this.core.memRead(this.l | (this.h << 8)) | (1 << bitNumber));
                else if (regCode === 7)
                    this.a |= (1 << bitNumber);
            }

            this.cycleCounter += this.cycleCountsCb[opcode];
        };
        // 0xcc : CALL Z, nn
        this.instructions[0xcc] = () => {
            this.doConditionalCall(!!this.flags.Z);
        };
        // 0xcd : CALL nn
        this.instructions[0xcd] = () => {
            this.pushWord((this.pc + 3) & 0xffff);
            this.pc = this.core.memRead((this.pc + 1) & 0xffff) |
                (this.core.memRead((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xce : ADC A, n
        this.instructions[0xce] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doAdc(this.core.memRead(this.pc));
        };
        // 0xcf : RST 08h
        this.instructions[0xcf] = () => {
            this.doReset(0x08);
        };
        // 0xd0 : RET NC
        this.instructions[0xd0] = () => {
            this.doConditionalReturn(!this.flags.C);
        };
        // 0xd1 : POP DE
        this.instructions[0xd1] = () => {
            var result = this.popWord();
            this.e = result & 0xff;
            this.d = (result & 0xff00) >>> 8;
        };
        // 0xd2 : JP NC, nn
        this.instructions[0xd2] = () => {
            this.doConditionalAbsoluteJump(!this.flags.C);
        };
        // 0xd3 : OUT (n), A
        this.instructions[0xd3] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.core.ioWrite((this.a << 8) | this.core.memRead(this.pc), this.a);
        };
        // 0xd4 : CALL NC, nn
        this.instructions[0xd4] = () => {
            this.doConditionalCall(!this.flags.C);
        };
        // 0xd5 : PUSH DE
        this.instructions[0xd5] = () => {
            this.pushWord(this.e | (this.d << 8));
        };
        // 0xd6 : SUB n
        this.instructions[0xd6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doSub(this.core.memRead(this.pc));
        };
        // 0xd7 : RST 10h
        this.instructions[0xd7] = () => {
            this.doReset(0x10);
        };
        // 0xd8 : RET C
        this.instructions[0xd8] = () => {
            this.doConditionalReturn(!!this.flags.C);
        };
        // 0xd9 : EXX
        this.instructions[0xd9] = () => {
            var temp = this.b;
            this.b = this.b_;
            this.b_ = temp;
            temp = this.c;
            this.c = this.c_;
            this.c_ = temp;
            temp = this.d;
            this.d = this.d_;
            this.d_ = temp;
            temp = this.e;
            this.e = this.e_;
            this.e_ = temp;
            temp = this.h;
            this.h = this.h_;
            this.h_ = temp;
            temp = this.l;
            this.l = this.l_;
            this.l_ = temp;
        };
        // 0xda : JP C, nn
        this.instructions[0xda] = () => {
            this.doConditionalAbsoluteJump(!!this.flags.C);
        };
        // 0xdb : IN A, (n)
        this.instructions[0xdb] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.a = this.core.ioRead((this.a << 8) | this.core.memRead(this.pc));
        };
        // 0xdc : CALL C, nn
        this.instructions[0xdc] = () => {
            this.doConditionalCall(!!this.flags.C);
        };
        // 0xdd : DD Prefix (IX instructions)
        this.instructions[0xdd] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.memRead(this.pc),
                func = this.ddInstructions[opcode];

            if (func) {
                func();
                this.cycleCounter += this.cycleCountsDd[opcode];
            }
            else {
                // Apparently if a DD opcode doesn't exist,
                //  it gets treated as an unprefixed opcode.
                // What we'll do to handle that is just back up the 
                //  program counter, so that this byte gets decoded
                //  as a normal instruction.
                this.pc = (this.pc - 1) & 0xffff;
                // And we'll add in the cycle count for a NOP.
                this.cycleCounter += this.cycleCounts[0];
            }
        };
        // 0xde : SBC n
        this.instructions[0xde] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doSbc(this.core.memRead(this.pc));
        };
        // 0xdf : RST 18h
        this.instructions[0xdf] = () => {
            this.doReset(0x18);
        };
        // 0xe0 : RET PO
        this.instructions[0xe0] = () => {
            this.doConditionalReturn(!this.flags.P);
        };
        // 0xe1 : POP HL
        this.instructions[0xe1] = () => {
            var result = this.popWord();
            this.l = result & 0xff;
            this.h = (result & 0xff00) >>> 8;
        };
        // 0xe2 : JP PO, (nn)
        this.instructions[0xe2] = () => {
            this.doConditionalAbsoluteJump(!this.flags.P);
        };
        // 0xe3 : EX (SP), HL
        this.instructions[0xe3] = () => {
            var temp = this.core.memRead(this.sp);
            this.core.memWrite(this.sp, this.l);
            this.l = temp;
            temp = this.core.memRead((this.sp + 1) & 0xffff);
            this.core.memWrite((this.sp + 1) & 0xffff, this.h);
            this.h = temp;
        };
        // 0xe4 : CALL PO, nn
        this.instructions[0xe4] = () => {
            this.doConditionalCall(!this.flags.P);
        };
        // 0xe5 : PUSH HL
        this.instructions[0xe5] = () => {
            this.pushWord(this.l | (this.h << 8));
        };
        // 0xe6 : AND n
        this.instructions[0xe6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doAnd(this.core.memRead(this.pc));
        };
        // 0xe7 : RST 20h
        this.instructions[0xe7] = () => {
            this.doReset(0x20);
        };
        // 0xe8 : RET PE
        this.instructions[0xe8] = () => {
            this.doConditionalReturn(!!this.flags.P);
        };
        // 0xe9 : JP (HL)
        this.instructions[0xe9] = () => {
            this.pc = this.l | (this.h << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xea : JP PE, nn
        this.instructions[0xea] = () => {
            this.doConditionalAbsoluteJump(!!this.flags.P);
        };
        // 0xeb : EX DE, HL
        this.instructions[0xeb] = () => {
            var temp = this.d;
            this.d = this.h;
            this.h = temp;
            temp = this.e;
            this.e = this.l;
            this.l = temp;
        };
        // 0xec : CALL PE, nn
        this.instructions[0xec] = () => {
            this.doConditionalCall(!!this.flags.P);
        };
        // 0xed : ED Prefix
        this.instructions[0xed] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.memRead(this.pc),
                func = this.edInstructions[opcode];

            if (func) {
                func();
                this.cycleCounter += this.cycleCountsEd[opcode];
            }
            else {
                // If the opcode didn't exist, the whole thing is a two-byte NOP.
                this.cycleCounter += this.cycleCounts[0];
            }
        };
        // 0xee : XOR n
        this.instructions[0xee] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doXor(this.core.memRead(this.pc));
        };
        // 0xef : RST 28h
        this.instructions[0xef] = () => {
            this.doReset(0x28);
        };
        // 0xf0 : RET P
        this.instructions[0xf0] = () => {
            this.doConditionalReturn(!this.flags.S);
        };
        // 0xf1 : POP AF
        this.instructions[0xf1] = () => {
            var result = this.popWord();
            this.setFlags(result & 0xff);
            this.a = (result & 0xff00) >>> 8;
        };
        // 0xf2 : JP P, nn
        this.instructions[0xf2] = () => {
            this.doConditionalAbsoluteJump(!this.flags.S);
        };
        // 0xf3 : DI
        this.instructions[0xf3] = () => {
            // DI doesn't actually take effect until after the next instruction.
            this.doDelayedDi = true;
        };
        // 0xf4 : CALL P, nn
        this.instructions[0xf4] = () => {
            this.doConditionalCall(!this.flags.S);
        };
        // 0xf5 : PUSH AF
        this.instructions[0xf5] = () => {
            this.pushWord(this.getFlags() | (this.a << 8));
        };
        // 0xf6 : OR n
        this.instructions[0xf6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doOr(this.core.memRead(this.pc));
        };
        // 0xf7 : RST 30h
        this.instructions[0xf7] = () => {
            this.doReset(0x30);
        };
        // 0xf8 : RET M
        this.instructions[0xf8] = () => {
            this.doConditionalReturn(!!this.flags.S);
        };
        // 0xf9 : LD SP, HL
        this.instructions[0xf9] = () => {
            this.sp = this.l | (this.h << 8);
        };
        // 0xfa : JP M, nn
        this.instructions[0xfa] = () => {
            this.doConditionalAbsoluteJump(!!this.flags.S);
        };
        // 0xfb : EI
        this.instructions[0xfb] = () => {
            // EI doesn't actually take effect until after the next instruction.
            this.doDelayedEi = true;
        };
        // 0xfc : CALL M, nn
        this.instructions[0xfc] = () => {
            this.doConditionalCall(!!this.flags.S);
        };
        // 0xfd : FD Prefix (IY instructions)
        this.instructions[0xfd] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.memRead(this.pc),
                func = this.ddInstructions[opcode];

            if (func) {
                // Rather than copy and paste all the IX instructions into IY instructions,
                //  what we'll do is sneakily copy IY into IX, run the IX instruction,
                //  and then copy the result into IY and restore the old IX.
                var temp = this.ix;
                this.ix = this.iy;
                func();
                this.iy = this.ix;
                this.ix = temp;

                this.cycleCounter += this.cycleCountsDd[opcode];
            }
            else {
                // Apparently if an FD opcode doesn't exist,
                //  it gets treated as an unprefixed opcode.
                // What we'll do to handle that is just back up the 
                //  program counter, so that this byte gets decoded
                //  as a normal instruction.
                this.pc = (this.pc - 1) & 0xffff;
                // And we'll add in the cycle count for a NOP.
                this.cycleCounter += this.cycleCounts[0];
            }
        };
        // 0xfe : CP n
        this.instructions[0xfe] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.doCp(this.core.memRead(this.pc));
        };
        // 0xff : RST 38h
        this.instructions[0xff] = () => {
            this.doReset(0x38);
        };
    }


    ///////////////////////////////////////////////////////////////////////////////
    /// This table of ED opcodes is pretty sparse;
    ///  there are not very many valid ED-prefixed opcodes in the Z80,
    ///  and many of the ones that are valid are not documented.
    ///////////////////////////////////////////////////////////////////////////////
    private edInstructions = [];

    private initializeEdInstructions() {
        // 0x40 : IN B, (C)
        this.edInstructions[0x40] = () => {
            this.b = this.doIn((this.b << 8) | this.c);
        };
        // 0x41 : OUT (C), B
        this.edInstructions[0x41] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.b);
        };
        // 0x42 : SBC HL, BC
        this.edInstructions[0x42] = () => {
            this.doHlSbc(this.c | (this.b << 8));
        };
        // 0x43 : LD (nn), BC
        this.edInstructions[0x43] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.c);
            this.core.memWrite((address + 1) & 0xffff, this.b);
        };
        // 0x44 : NEG
        this.edInstructions[0x44] = () => {
            this.doNeg();
        };
        // 0x45 : RETN
        this.edInstructions[0x45] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x46 : IM 0
        this.edInstructions[0x46] = () => {
            this.imode = 0;
        };
        // 0x47 : LD I, A
        this.edInstructions[0x47] = () => {
            this.i = this.a
        };
        // 0x48 : IN C, (C)
        this.edInstructions[0x48] = () => {
            this.c = this.doIn((this.b << 8) | this.c);
        };
        // 0x49 : OUT (C), C
        this.edInstructions[0x49] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.c);
        };
        // 0x4a : ADC HL, BC
        this.edInstructions[0x4a] = () => {
            this.doHlAdc(this.c | (this.b << 8));
        };
        // 0x4b : LD BC, (nn)
        this.edInstructions[0x4b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.c = this.core.memRead(address);
            this.b = this.core.memRead((address + 1) & 0xffff);
        };
        // 0x4c : NEG (Undocumented)
        this.edInstructions[0x4c] = () => {
            this.doNeg();
        };
        // 0x4d : RETI
        this.edInstructions[0x4d] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
        };
        // 0x4e : IM 0 (Undocumented)
        this.edInstructions[0x4e] = () => {
            this.imode = 0;
        };
        // 0x4f : LD R, A
        this.edInstructions[0x4f] = () => {
            this.r = this.a;
        };
        // 0x50 : IN D, (C)
        this.edInstructions[0x50] = () => {
            this.d = this.doIn((this.b << 8) | this.c);
        };
        // 0x51 : OUT (C), D
        this.edInstructions[0x51] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.d);
        };
        // 0x52 : SBC HL, DE
        this.edInstructions[0x52] = () => {
            this.doHlSbc(this.e | (this.d << 8));
        };
        // 0x53 : LD (nn), DE
        this.edInstructions[0x53] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.e);
            this.core.memWrite((address + 1) & 0xffff, this.d);
        };
        // 0x54 : NEG (Undocumented)
        this.edInstructions[0x54] = () => {
            this.doNeg();
        };
        // 0x55 : RETN
        this.edInstructions[0x55] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x56 : IM 1
        this.edInstructions[0x56] = () => {
            this.imode = 1;
        };
        // 0x57 : LD A, I
        this.edInstructions[0x57] = () => {
            this.a = this.i;
            this.flags.P = this.iff2;
        };
        // 0x58 : IN E, (C)
        this.edInstructions[0x58] = () => {
            this.e = this.doIn((this.b << 8) | this.c);
        };
        // 0x59 : OUT (C), E
        this.edInstructions[0x59] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.e);
        };
        // 0x5a : ADC HL, DE
        this.edInstructions[0x5a] = () => {
            this.doHlAdc(this.e | (this.d << 8));
        };
        // 0x5b : LD DE, (nn)
        this.edInstructions[0x5b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.e = this.core.memRead(address);
            this.d = this.core.memRead((address + 1) & 0xffff);
        };
        // 0x5c : NEG (Undocumented)
        this.edInstructions[0x5c] = () => {
            this.doNeg();
        };
        // 0x5d : RETN
        this.edInstructions[0x5d] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x5e : IM 2
        this.edInstructions[0x5e] = () => {
            this.imode = 2;
        };
        // 0x5f : LD A, R
        this.edInstructions[0x5f] = () => {
            this.a = this.r;
            this.flags.P = this.iff2;
        };
        // 0x60 : IN H, (C)
        this.edInstructions[0x60] = () => {
            this.h = this.doIn((this.b << 8) | this.c);
        };
        // 0x61 : OUT (C), H
        this.edInstructions[0x61] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.h);
        };
        // 0x62 : SBC HL, HL
        this.edInstructions[0x62] = () => {
            this.doHlSbc(this.l | (this.h << 8));
        };
        // 0x63 : LD (nn), HL (Undocumented)
        this.edInstructions[0x63] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.l);
            this.core.memWrite((address + 1) & 0xffff, this.h);
        };
        // 0x64 : NEG (Undocumented)
        this.edInstructions[0x64] = () => {
            this.doNeg();
        };
        // 0x65 : RETN
        this.edInstructions[0x65] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x66 : IM 0
        this.edInstructions[0x66] = () => {
            this.imode = 0;
        };
        // 0x67 : RRD
        this.edInstructions[0x67] = () => {
            var hlValue = this.core.memRead(this.l | (this.h << 8));
            var temp1 = hlValue & 0x0f, temp2 = this.a & 0x0f;
            hlValue = ((hlValue & 0xf0) >>> 4) | (temp2 << 4);
            this.a = (this.a & 0xf0) | temp1;
            this.core.memWrite(this.l | (this.h << 8), hlValue);

            this.flags.S = (this.a & 0x80) ? 1 : 0;
            this.flags.Z = this.a ? 0 : 1;
            this.flags.H = 0;
            this.flags.P = this.getParity(this.a) ? 1 : 0;
            this.flags.N = 0;
            this.updateXyFlags(this.a);
        };
        // 0x68 : IN L, (C)
        this.edInstructions[0x68] = () => {
            this.l = this.doIn((this.b << 8) | this.c);
        };
        // 0x69 : OUT (C), L
        this.edInstructions[0x69] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.l);
        };
        // 0x6a : ADC HL, HL
        this.edInstructions[0x6a] = () => {
            this.doHlAdc(this.l | (this.h << 8));
        };
        // 0x6b : LD HL, (nn) (Undocumented)
        this.edInstructions[0x6b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.l = this.core.memRead(address);
            this.h = this.core.memRead((address + 1) & 0xffff);
        };
        // 0x6c : NEG (Undocumented)
        this.edInstructions[0x6c] = () => {
            this.doNeg();
        };
        // 0x6d : RETN
        this.edInstructions[0x6d] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x6e : IM 0 (Undocumented)
        this.edInstructions[0x6e] = () => {
            this.imode = 0;
        };
        // 0x6f : RLD
        this.edInstructions[0x6f] = () => {
            var hlValue = this.core.memRead(this.l | (this.h << 8));
            var temp1 = hlValue & 0xf0, temp2 = this.a & 0x0f;
            hlValue = ((hlValue & 0x0f) << 4) | temp2;
            this.a = (this.a & 0xf0) | (temp1 >>> 4);
            this.core.memWrite(this.l | (this.h << 8), hlValue);

            this.flags.S = (this.a & 0x80) ? 1 : 0;
            this.flags.Z = this.a ? 0 : 1;
            this.flags.H = 0;
            this.flags.P = this.getParity(this.a) ? 1 : 0;
            this.flags.N = 0;
            this.updateXyFlags(this.a);
        };
        // 0x70 : IN (C) (Undocumented)
        this.edInstructions[0x70] = () => {
            this.doIn((this.b << 8) | this.c);
        };
        // 0x71 : OUT (C), 0 (Undocumented)
        this.edInstructions[0x71] = () => {
            this.core.ioWrite((this.b << 8) | this.c, 0);
        };
        // 0x72 : SBC HL, SP
        this.edInstructions[0x72] = () => {
            this.doHlSbc(this.sp);
        };
        // 0x73 : LD (nn), SP
        this.edInstructions[0x73] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.core.memWrite(address, this.sp & 0xff);
            this.core.memWrite((address + 1) & 0xffff, (this.sp >>> 8) & 0xff);
        };
        // 0x74 : NEG (Undocumented)
        this.edInstructions[0x74] = () => {
            this.doNeg();
        };
        // 0x75 : RETN
        this.edInstructions[0x75] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x76 : IM 1
        this.edInstructions[0x76] = () => {
            this.imode = 1;
        };
        // 0x78 : IN A, (C)
        this.edInstructions[0x78] = () => {
            this.a = this.doIn((this.b << 8) | this.c);
        };
        // 0x79 : OUT (C), A
        this.edInstructions[0x79] = () => {
            this.core.ioWrite((this.b << 8) | this.c, this.a);
        };
        // 0x7a : ADC HL, SP
        this.edInstructions[0x7a] = () => {
            this.doHlAdc(this.sp);
        };
        // 0x7b : LD SP, (nn)
        this.edInstructions[0x7b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.memRead(this.pc) << 8;

            this.sp = this.core.memRead(address);
            this.sp |= this.core.memRead((address + 1) & 0xffff) << 8;
        };
        // 0x7c : NEG (Undocumented)
        this.edInstructions[0x7c] = () => {
            this.doNeg();
        };
        // 0x7d : RETN
        this.edInstructions[0x7d] = () => {
            this.pc = (this.popWord() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x7e : IM 2
        this.edInstructions[0x7e] = () => {
            this.imode = 2;
        };
        // 0xa0 : LDI
        this.edInstructions[0xa0] = () => {
            this.doLdi();
        };
        // 0xa1 : CPI
        this.edInstructions[0xa1] = () => {
            this.doCpi();
        };
        // 0xa2 : INI
        this.edInstructions[0xa2] = () => {
            this.doIni();
        };
        // 0xa3 : OUTI
        this.edInstructions[0xa3] = () => {
            this.doOuti();
        };
        // 0xa8 : LDD
        this.edInstructions[0xa8] = () => {
            this.doLdd();
        };
        // 0xa9 : CPD
        this.edInstructions[0xa9] = () => {
            this.doCpd();
        };
        // 0xaa : IND
        this.edInstructions[0xaa] = () => {
            this.doInd();
        };
        // 0xab : OUTD
        this.edInstructions[0xab] = () => {
            this.doOutd();
        };
        // 0xb0 : LDIR
        this.edInstructions[0xb0] = () => {
            this.doLdi();
            if (this.b || this.c) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb1 : CPIR
        this.edInstructions[0xb1] = () => {
            this.doCpi();
            if (!this.flags.Z && (this.b || this.c)) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb2 : INIR
        this.edInstructions[0xb2] = () => {
            this.doIni();
            if (this.b) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb3 : OTIR
        this.edInstructions[0xb3] = () => {
            this.doOuti();
            if (this.b) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb8 : LDDR
        this.edInstructions[0xb8] = () => {
            this.doLdd();
            if (this.b || this.c) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb9 : CPDR
        this.edInstructions[0xb9] = () => {
            this.doCpd();
            if (!this.flags.Z && (this.b || this.c)) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xba : INDR
        this.edInstructions[0xba] = () => {
            this.doInd();
            if (this.b) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xbb : OTDR
        this.edInstructions[0xbb] = () => {
            this.doOutd();
            if (this.b) {
                this.cycleCounter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
    }

    ///////////////////////////////////////////////////////////////////////////////
    /// Like ED, this table is quite sparse,
    ///  and many of the opcodes here are also undocumented.
    /// The undocumented instructions here are those that deal with only one byte
    ///  of the two-byte IX register; the bytes are designed IXH and IXL here.
    ///////////////////////////////////////////////////////////////////////////////
    private ddInstructions = [];

    private initializeDdInstructions() {
        // 0x09 : ADD IX, BC
        this.ddInstructions[0x09] = () => {
            this.doIxAdd(this.c | (this.b << 8));
        };
        // 0x19 : ADD IX, DE
        this.ddInstructions[0x19] = () => {
            this.doIxAdd(this.e | (this.d << 8));
        };
        // 0x21 : LD IX, nn
        this.ddInstructions[0x21] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.ix |= (this.core.memRead(this.pc) << 8);
        };
        // 0x22 : LD (nn), IX
        this.ddInstructions[0x22] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= (this.core.memRead(this.pc) << 8);

            this.core.memWrite(address, this.ix & 0xff);
            this.core.memWrite((address + 1) & 0xffff, (this.ix >>> 8) & 0xff);
        };
        // 0x23 : INC IX
        this.ddInstructions[0x23] = () => {
            this.ix = (this.ix + 1) & 0xffff;
        };
        // 0x24 : INC IXH (Undocumented)
        this.ddInstructions[0x24] = () => {
            this.ix = (this.doInc(this.ix >>> 8) << 8) | (this.ix & 0xff);
        };
        // 0x25 : DEC IXH (Undocumented)
        this.ddInstructions[0x25] = () => {
            this.ix = (this.doDec(this.ix >>> 8) << 8) | (this.ix & 0xff);
        };
        // 0x26 : LD IXH, n (Undocumented)
        this.ddInstructions[0x26] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = (this.core.memRead(this.pc) << 8) | (this.ix & 0xff);
        };
        // 0x29 : ADD IX, IX
        this.ddInstructions[0x29] = () => {
            this.doIxAdd(this.ix);
        };
        // 0x2a : LD IX, (nn)
        this.ddInstructions[0x2a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.memRead(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= (this.core.memRead(this.pc) << 8);

            this.ix = this.core.memRead(address);
            this.ix |= (this.core.memRead((address + 1) & 0xffff) << 8);
        };
        // 0x2b : DEC IX
        this.ddInstructions[0x2b] = () => {
            this.ix = (this.ix - 1) & 0xffff;
        };
        // 0x2c : INC IXL (Undocumented)
        this.ddInstructions[0x2c] = () => {
            this.ix = this.doInc(this.ix & 0xff) | (this.ix & 0xff00);
        };
        // 0x2d : DEC IXL (Undocumented)
        this.ddInstructions[0x2d] = () => {
            this.ix = this.doDec(this.ix & 0xff) | (this.ix & 0xff00);
        };
        // 0x2e : LD IXL, n (Undocumented)
        this.ddInstructions[0x2e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = (this.core.memRead(this.pc) & 0xff) | (this.ix & 0xff00);
        };
        // 0x34 : INC (IX+n)
        this.ddInstructions[0x34] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc)),
                value = this.core.memRead((offset + this.ix) & 0xffff);
            this.core.memWrite((offset + this.ix) & 0xffff, this.doInc(value));
        };
        // 0x35 : DEC (IX+n)
        this.ddInstructions[0x35] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc)),
                value = this.core.memRead((offset + this.ix) & 0xffff);
            this.core.memWrite((offset + this.ix) & 0xffff, this.doDec(value));
        };
        // 0x36 : LD (IX+n), n
        this.ddInstructions[0x36] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.pc = (this.pc + 1) & 0xffff;
            this.core.memWrite((this.ix + offset) & 0xffff, this.core.memRead(this.pc));
        };
        // 0x39 : ADD IX, SP
        this.ddInstructions[0x39] = () => {
            this.doIxAdd(this.sp);
        };
        // 0x44 : LD B, IXH (Undocumented)
        this.ddInstructions[0x44] = () => {
            this.b = (this.ix >>> 8) & 0xff;
        };
        // 0x45 : LD B, IXL (Undocumented)
        this.ddInstructions[0x45] = () => {
            this.b = this.ix & 0xff;
        };
        // 0x46 : LD B, (IX+n)
        this.ddInstructions[0x46] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.b = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x4c : LD C, IXH (Undocumented)
        this.ddInstructions[0x4c] = () => {
            this.c = (this.ix >>> 8) & 0xff;
        };
        // 0x4d : LD C, IXL (Undocumented)
        this.ddInstructions[0x4d] = () => {
            this.c = this.ix & 0xff;
        };
        // 0x4e : LD C, (IX+n)
        this.ddInstructions[0x4e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.c = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x54 : LD D, IXH (Undocumented)
        this.ddInstructions[0x54] = () => {
            this.d = (this.ix >>> 8) & 0xff;
        };
        // 0x55 : LD D, IXL (Undocumented)
        this.ddInstructions[0x55] = () => {
            this.d = this.ix & 0xff;
        };
        // 0x56 : LD D, (IX+n)
        this.ddInstructions[0x56] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.d = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x5c : LD E, IXH (Undocumented)
        this.ddInstructions[0x5c] = () => {
            this.e = (this.ix >>> 8) & 0xff;
        };
        // 0x5d : LD E, IXL (Undocumented)
        this.ddInstructions[0x5d] = () => {
            this.e = this.ix & 0xff;
        };
        // 0x5e : LD E, (IX+n)
        this.ddInstructions[0x5e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.e = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x60 : LD IXH, B (Undocumented)
        this.ddInstructions[0x60] = () => {
            this.ix = (this.ix & 0xff) | (this.b << 8);
        };
        // 0x61 : LD IXH, C (Undocumented)
        this.ddInstructions[0x61] = () => {
            this.ix = (this.ix & 0xff) | (this.c << 8);
        };
        // 0x62 : LD IXH, D (Undocumented)
        this.ddInstructions[0x62] = () => {
            this.ix = (this.ix & 0xff) | (this.d << 8);
        };
        // 0x63 : LD IXH, E (Undocumented)
        this.ddInstructions[0x63] = () => {
            this.ix = (this.ix & 0xff) | (this.e << 8);
        };
        // 0x64 : LD IXH, IXH (Undocumented)
        this.ddInstructions[0x64] = () => {
            // No-op.
        };
        // 0x65 : LD IXH, IXL (Undocumented)
        this.ddInstructions[0x65] = () => {
            this.ix = (this.ix & 0xff) | ((this.ix & 0xff) << 8);
        };
        // 0x66 : LD H, (IX+n)
        this.ddInstructions[0x66] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.h = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x67 : LD IXH, A (Undocumented)
        this.ddInstructions[0x67] = () => {
            this.ix = (this.ix & 0xff) | (this.a << 8);
        };
        // 0x68 : LD IXL, B (Undocumented)
        this.ddInstructions[0x68] = () => {
            this.ix = (this.ix & 0xff00) | this.b;
        };
        // 0x69 : LD IXL, C (Undocumented)
        this.ddInstructions[0x69] = () => {
            this.ix = (this.ix & 0xff00) | this.c;
        };
        // 0x6a : LD IXL, D (Undocumented)
        this.ddInstructions[0x6a] = () => {
            this.ix = (this.ix & 0xff00) | this.d;
        };
        // 0x6b : LD IXL, E (Undocumented)
        this.ddInstructions[0x6b] = () => {
            this.ix = (this.ix & 0xff00) | this.e;
        };
        // 0x6c : LD IXL, IXH (Undocumented)
        this.ddInstructions[0x6c] = () => {
            this.ix = (this.ix & 0xff00) | (this.ix >>> 8);
        };
        // 0x6d : LD IXL, IXL (Undocumented)
        this.ddInstructions[0x6d] = () => {
            // No-op.
        };
        // 0x6e : LD L, (IX+n)
        this.ddInstructions[0x6e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.l = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x6f : LD IXL, A (Undocumented)
        this.ddInstructions[0x6f] = () => {
            this.ix = (this.ix & 0xff00) | this.a;
        };
        // 0x70 : LD (IX+n), B
        this.ddInstructions[0x70] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.b);
        };
        // 0x71 : LD (IX+n), C
        this.ddInstructions[0x71] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.c);
        };
        // 0x72 : LD (IX+n), D
        this.ddInstructions[0x72] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.d);
        };
        // 0x73 : LD (IX+n), E
        this.ddInstructions[0x73] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.e);
        };
        // 0x74 : LD (IX+n), H
        this.ddInstructions[0x74] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.h);
        };
        // 0x75 : LD (IX+n), L
        this.ddInstructions[0x75] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.l);
        };
        // 0x77 : LD (IX+n), A
        this.ddInstructions[0x77] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.core.memWrite((this.ix + offset) & 0xffff, this.a);
        };
        // 0x7c : LD A, IXH (Undocumented)
        this.ddInstructions[0x7c] = () => {
            this.a = (this.ix >>> 8) & 0xff;
        };
        // 0x7d : LD A, IXL (Undocumented)
        this.ddInstructions[0x7d] = () => {
            this.a = this.ix & 0xff;
        };
        // 0x7e : LD A, (IX+n)
        this.ddInstructions[0x7e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.a = this.core.memRead((this.ix + offset) & 0xffff);
        };
        // 0x84 : ADD A, IXH (Undocumented)
        this.ddInstructions[0x84] = () => {
            this.doAdd((this.ix >>> 8) & 0xff);
        };
        // 0x85 : ADD A, IXL (Undocumented)
        this.ddInstructions[0x85] = () => {
            this.doAdd(this.ix & 0xff);
        };
        // 0x86 : ADD A, (IX+n)
        this.ddInstructions[0x86] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doAdd(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0x8c : ADC A, IXH (Undocumented)
        this.ddInstructions[0x8c] = () => {
            this.doAdc((this.ix >>> 8) & 0xff);
        };
        // 0x8d : ADC A, IXL (Undocumented)
        this.ddInstructions[0x8d] = () => {
            this.doAdc(this.ix & 0xff);
        };
        // 0x8e : ADC A, (IX+n)
        this.ddInstructions[0x8e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doAdc(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0x94 : SUB IXH (Undocumented)
        this.ddInstructions[0x94] = () => {
            this.doSub((this.ix >>> 8) & 0xff);
        };
        // 0x95 : SUB IXL (Undocumented)
        this.ddInstructions[0x95] = () => {
            this.doSub(this.ix & 0xff);
        };
        // 0x96 : SUB A, (IX+n)
        this.ddInstructions[0x96] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doSub(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0x9c : SBC IXH (Undocumented)
        this.ddInstructions[0x9c] = () => {
            this.doSbc((this.ix >>> 8) & 0xff);
        };
        // 0x9d : SBC IXL (Undocumented)
        this.ddInstructions[0x9d] = () => {
            this.doSbc(this.ix & 0xff);
        };
        // 0x9e : SBC A, (IX+n)
        this.ddInstructions[0x9e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doSbc(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0xa4 : AND IXH (Undocumented)
        this.ddInstructions[0xa4] = () => {
            this.doAnd((this.ix >>> 8) & 0xff);
        };
        // 0xa5 : AND IXL (Undocumented)
        this.ddInstructions[0xa5] = () => {
            this.doAnd(this.ix & 0xff);
        };
        // 0xa6 : AND A, (IX+n)
        this.ddInstructions[0xa6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doAnd(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0xac : XOR IXH (Undocumented)
        this.ddInstructions[0xac] = () => {
            this.doXor((this.ix >>> 8) & 0xff);
        };
        // 0xad : XOR IXL (Undocumented)
        this.ddInstructions[0xad] = () => {
            this.doXor(this.ix & 0xff);
        };
        // 0xae : XOR A, (IX+n)
        this.ddInstructions[0xae] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doXor(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0xb4 : OR IXH (Undocumented)
        this.ddInstructions[0xb4] = () => {
            this.doOr((this.ix >>> 8) & 0xff);
        };
        // 0xb5 : OR IXL (Undocumented)
        this.ddInstructions[0xb5] = () => {
            this.doOr(this.ix & 0xff);
        };
        // 0xb6 : OR A, (IX+n)
        this.ddInstructions[0xb6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doOr(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0xbc : CP IXH (Undocumented)
        this.ddInstructions[0xbc] = () => {
            this.doCp((this.ix >>> 8) & 0xff);
        };
        // 0xbd : CP IXL (Undocumented)
        this.ddInstructions[0xbd] = () => {
            this.doCp(this.ix & 0xff);
        };
        // 0xbe : CP A, (IX+n)
        this.ddInstructions[0xbe] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.doCp(this.core.memRead((this.ix + offset) & 0xffff));
        };
        // 0xcb : CB Prefix (IX bit instructions)
        this.ddInstructions[0xcb] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.getSignedOffsetByte(this.core.memRead(this.pc));
            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.memRead(this.pc), value;

            // As with the "normal" CB prefix, we implement the DDCB prefix
            //  by decoding the opcode directly, rather than using a table.
            if (opcode < 0x40) {
                // Shift and rotate instructions.
                var ddcbFunctions = [this.doRlc, this.doRrc, this.doRl, this.doRr,
                this.doSla, this.doSra, this.doSll, this.doSrl];

                // Most of the opcodes in this range are not valid,
                //  so we map this opcode onto one of the ones that is.
                var func = ddcbFunctions[(opcode & 0x38) >>> 3],
                    value = func.call(this, this.core.memRead((this.ix + offset) & 0xffff));

                this.core.memWrite((this.ix + offset) & 0xffff, value);
            }
            else {
                var bitNumber = (opcode & 0x38) >>> 3;

                if (opcode < 0x80) {
                    // BIT
                    this.flags.N = 0;
                    this.flags.H = 1;
                    this.flags.Z = !(this.core.memRead((this.ix + offset) & 0xffff) & (1 << bitNumber)) ? 1 : 0;
                    this.flags.P = this.flags.Z;
                    this.flags.S = ((bitNumber === 7) && !this.flags.Z) ? 1 : 0;
                }
                else if (opcode < 0xc0) {
                    // RES
                    value = this.core.memRead((this.ix + offset) & 0xffff) & ~(1 << bitNumber) & 0xff;
                    this.core.memWrite((this.ix + offset) & 0xffff, value);
                }
                else {
                    // SET
                    value = this.core.memRead((this.ix + offset) & 0xffff) | (1 << bitNumber);
                    this.core.memWrite((this.ix + offset) & 0xffff, value);
                }
            }

            // This implements the undocumented shift, RES, and SET opcodes,
            //  which write their result to memory and also to an 8080 register.
            if (value !== undefined) {
                if ((opcode & 0x07) === 0)
                    this.b = value;
                else if ((opcode & 0x07) === 1)
                    this.c = value;
                else if ((opcode & 0x07) === 2)
                    this.d = value;
                else if ((opcode & 0x07) === 3)
                    this.e = value;
                else if ((opcode & 0x07) === 4)
                    this.h = value;
                else if ((opcode & 0x07) === 5)
                    this.l = value;
                // 6 is the documented opcode, which doesn't set a register.
                else if ((opcode & 0x07) === 7)
                    this.a = value;
            }

            this.cycleCounter += this.cycleCountsCb[opcode] + 8;
        };
        // 0xe1 : POP IX
        this.ddInstructions[0xe1] = () => {
            this.ix = this.popWord();
        };
        // 0xe3 : EX (SP), IX
        this.ddInstructions[0xe3] = () => {
            var temp = this.ix;
            this.ix = this.core.memRead(this.sp);
            this.ix |= this.core.memRead((this.sp + 1) & 0xffff) << 8;
            this.core.memWrite(this.sp, temp & 0xff);
            this.core.memWrite((this.sp + 1) & 0xffff, (temp >>> 8) & 0xff);
        };
        // 0xe5 : PUSH IX
        this.ddInstructions[0xe5] = () => {
            this.pushWord(this.ix);
        };
        // 0xe9 : JP (IX)
        this.ddInstructions[0xe9] = () => {
            this.pc = (this.ix - 1) & 0xffff;
        };
        // 0xf9 : LD SP, IX
        this.ddInstructions[0xf9] = () => {
            this.sp = this.ix;
        };
    }

    ///////////////////////////////////////////////////////////////////////////////
    /// These tables contain the number of T cycles used for each instruction.
    /// In a few special cases, such as conditional control flow instructions,
    ///  additional cycles might be added to these values.
    /// The total number of cycles is the return value of runInstruction().
    ///////////////////////////////////////////////////////////////////////////////
    private cycleCounts = [
        4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4,
        8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
        7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4,
        7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
        5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11,
        5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
        5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11,
        5, 10, 10, 4, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11
    ];

    private cycleCountsEd = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        12, 12, 15, 20, 8, 14, 8, 9, 12, 12, 15, 20, 8, 14, 8, 9,
        12, 12, 15, 20, 8, 14, 8, 9, 12, 12, 15, 20, 8, 14, 8, 9,
        12, 12, 15, 20, 8, 14, 8, 18, 12, 12, 15, 20, 8, 14, 8, 18,
        12, 12, 15, 20, 8, 14, 8, 0, 12, 12, 15, 20, 8, 14, 8, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        16, 16, 16, 16, 0, 0, 0, 0, 16, 16, 16, 16, 0, 0, 0, 0,
        16, 16, 16, 16, 0, 0, 0, 0, 16, 16, 16, 16, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ];

    private cycleCountsCb = [
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 12, 8, 8, 8, 8, 8, 8, 8, 12, 8,
        8, 8, 8, 8, 8, 8, 12, 8, 8, 8, 8, 8, 8, 8, 12, 8,
        8, 8, 8, 8, 8, 8, 12, 8, 8, 8, 8, 8, 8, 8, 12, 8,
        8, 8, 8, 8, 8, 8, 12, 8, 8, 8, 8, 8, 8, 8, 12, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8,
        8, 8, 8, 8, 8, 8, 15, 8, 8, 8, 8, 8, 8, 8, 15, 8
    ];

    private cycleCountsDd = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0,
        0, 14, 20, 10, 8, 8, 11, 0, 0, 15, 20, 10, 8, 8, 11, 0,
        0, 0, 0, 0, 23, 23, 19, 0, 0, 15, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        8, 8, 8, 8, 8, 8, 19, 8, 8, 8, 8, 8, 8, 8, 19, 8,
        19, 19, 19, 19, 19, 19, 0, 19, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 8, 8, 19, 0, 0, 0, 0, 0, 8, 8, 19, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 14, 0, 23, 0, 15, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0
    ];

    public get hl() {
        return (this.h & 0xff) << 8 | (this.l & 0xff);
    }

    public set hl(value) {
        this.h = (value & 0xff00) >> 8;
        this.l = value & 0xff;
    }

    public get bc() {
        return (this.b & 0xff) << 8 | (this.c & 0xff);
    }

    public set bc(value) {
        this.b = (value & 0xff00) >> 8;
        this.c = value & 0xff;
    }

    public get de() {
        return (this.d & 0xff) << 8 | (this.e & 0xff);
    }

    public set de(value) {
        this.d = (value & 0xff00) >> 8;
        this.e = value & 0xff;
    }

    public get f() {
        return this.getFlags();
    }

    public set f(value) {
        this.setFlags(value);
    }

    public get af() {
        return (this.a & 0xff) << 8 | (this.f & 0xff);
    }

    public set af(value) {
        this.a = (value & 0xff00) >> 8;
        this.f = value & 0xff;
    }

    public get hl_() {
        return (this.h_ & 0xff) << 8 | (this.l_ & 0xff);
    }

    public set hl_(value) {
        this.h_ = (value & 0xff00) >> 8;
        this.l_ = value & 0xff;
    }

    public get bc_() {
        return (this.b_ & 0xff) << 8 | (this.c_ & 0xff);
    }

    public set bc_(value) {
        this.b_ = (value & 0xff00) >> 8;
        this.c_ = value & 0xff;
    }

    public get de_() {
        return (this.d_ & 0xff) << 8 | (this.e_ & 0xff);
    }

    public set de_(value) {
        this.d_ = (value & 0xff00) >> 8;
        this.e_ = value & 0xff;
    }

    public get f_() {
        return this.getFlags_();
    }

    public set f_(value) {
        this.setFlags_(value);
    }

    public get af_() {
        return (this.a_ & 0xff) << 8 | (this.f_ & 0xff);
    }

    public set af_(value) {
        this.a_ = (value & 0xff00) >> 8;
        this.f_ = value & 0xff;
    }
}