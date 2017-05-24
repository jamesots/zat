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

export interface Registers {
    a: number;
    flags: Flags;
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    a_alt: number;
    flags_alt: Flags;
    b_alt: number;
    c_alt: number;
    d_alt: number;
    e_alt: number;
    h_alt: number;
    l_alt: number;
    ix: number;
    iy: number;
    i: number;
    r: number;
    sp: number;
    pc: number;
    imode: number;
    iff1: number;
    iff2: number;
}

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
    public a_alt = 0x00;
    public b_alt = 0x00;
    public c_alt = 0x00;
    public d_alt = 0x00;
    public e_alt = 0x00;
    public h_alt = 0x00;
    public l_alt = 0x00;
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
    public flags_alt: Flags = { S: 0, Z: 0, Y: 0, H: 0, X: 0, P: 0, N: 0, C: 0 };
    // And finally we have the interrupt mode and flip-flop registers.
    public imode = 0;
    public iff1 = 0;
    public iff2 = 0;

    // These are all specific to this implementation, not Z80 features.
    // Keep track of whether we've had a HALT instruction called.
    public halted = false;
    // EI and DI wait one instruction before they take effect;
    //  these flags tell us when we're in that wait state.
    private do_delayed_di = false;
    private do_delayed_ei = false;
    // This tracks the number of cycles spent in a single instruction run,
    //  including processing any prefixes and handling interrupts.
    private cycle_counter = 0;

    constructor(private core: any) {
        // The argument to this constructor should be an object containing 4 functions:
        // mem_read(address) should return the byte at the given memory address,
        // mem_write(address, value) should write the given value to the given memory address,
        // io_read(port) should read a return a byte read from the given I/O port,
        // io_write(port, value) should write the given byte to the given I/O port.
        // If any of those functions is missing, this module cannot run.
        if (!core || (typeof core.mem_read !== "function") || (typeof core.mem_write !== "function") ||
            (typeof core.io_read !== "function") || (typeof core.io_write !== "function"))
            throw ("Z80: Core object is missing required functions.");

        // Obviously we'll be needing the core object's functions again.
        this.core = core;


        this.initializeInstructions();
        this.initializeEdInstructions();
        this.initializeDdInstructions();
    }

    public getRegisters(): Registers {
        return {
            a: this.a,
            flags: this.flags,
            b: this.b,
            c: this.c,
            d: this.d,
            e: this.e,
            h: this.h,
            l: this.l,
            a_alt: this.a_alt,
            flags_alt: this.flags_alt,
            b_alt: this.b_alt,
            c_alt: this.c_alt,
            d_alt: this.d_alt,
            e_alt: this.e_alt,
            h_alt: this.h_alt,
            l_alt: this.l_alt,
            ix: this.ix,
            iy: this.iy,
            i: this.i,
            r: this.r,
            sp: this.sp,
            pc: this.pc,
            imode: this.imode,
            iff1: this.iff1,
            iff2: this.iff2
        };
    }

    public setRegisters(registers: Registers): void {
        this.a = registers.a;
        this.flags = registers.flags;
        this.b = registers.b;
        this.c = registers.c;
        this.d = registers.d;
        this.e = registers.e;
        this.h = registers.h;
        this.l = registers.l;
        this.a_alt = registers.a_alt;
        this.flags_alt = registers.flags_alt;
        this.b_alt = registers.b_alt;
        this.c_alt = registers.c_alt;
        this.d_alt = registers.d_alt;
        this.e_alt = registers.e_alt;
        this.h_alt = registers.h_alt;
        this.l_alt = registers.l_alt;
        this.ix = registers.ix;
        this.iy = registers.iy;
        this.i = registers.i;
        this.r = registers.r;
        this.sp = registers.sp;
        this.pc = registers.pc;
        this.imode = registers.imode;
        this.iff1 = registers.iff1;
        this.iff2 = registers.iff2;
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
        this.set_flags_register(0);
        // Start up with interrupts disabled.
        this.imode = 0;
        this.iff1 = 0;
        this.iff2 = 0;
        // Don't start halted or in a delayed DI or EI.
        this.halted = false;
        this.do_delayed_di = false;
        this.do_delayed_ei = false;
        // Obviously we've not used any cycles yet.
        this.cycle_counter = 0;
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// @public run_instruction
    ///
    /// @brief Runs a single instruction
    ///
    /// @return The number of T cycles the instruction took to run,
    ///          plus any time that went into handling interrupts that fired
    ///          while this instruction was executing
    ///////////////////////////////////////////////////////////////////////////////
    public run_instruction() {
        if (!this.halted) {
            // If the previous instruction was a DI or an EI,
            //  we'll need to disable or enable interrupts
            //  after whatever instruction we're about to run is finished.
            var doing_delayed_di = false, doing_delayed_ei = false;
            if (this.do_delayed_di) {
                this.do_delayed_di = false;
                doing_delayed_di = true;
            }
            else if (this.do_delayed_ei) {
                this.do_delayed_ei = false;
                doing_delayed_ei = true;
            }

            // R is incremented at the start of every instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            // Read the byte at the PC and run the instruction it encodes.
            var opcode = this.core.mem_read(this.pc);
            this.decode_instruction(opcode);
            this.pc = (this.pc + 1) & 0xffff;

            // Actually do the delayed interrupt disable/enable if we have one.
            if (doing_delayed_di) {
                this.iff1 = 0;
                this.iff2 = 0;
            }
            else if (doing_delayed_ei) {
                this.iff1 = 1;
                this.iff2 = 1;
            }

            // And finally clear out the cycle counter for the next instruction
            //  before returning it to the emulator core.
            var retval = this.cycle_counter;
            this.cycle_counter = 0;
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
    /// @param non_maskable - true if this is a non-maskable interrupt
    /// @param data - the value to be placed on the data bus, if needed
    ///////////////////////////////////////////////////////////////////////////////
    public interrupt(non_maskable, data) {
        if (non_maskable) {
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);
            // Non-maskable interrupts are always handled the same way;
            //  clear IFF1 and then do a CALL 0x0066.
            // Also, all interrupts reset the HALT state.
            this.halted = false;
            this.iff2 = this.iff1;
            this.iff1 = 0;
            this.push_word(this.pc);
            this.pc = 0x66;
            this.cycle_counter += 11;
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
                this.decode_instruction(data);
                this.cycle_counter += 2;
            }
            else if (this.imode === 1) {
                // Mode 1 is always just RST 0x38.
                this.push_word(this.pc);
                this.pc = 0x38;
                this.cycle_counter += 13;
            }
            else if (this.imode === 2) {
                // Mode 2 uses the value on the data bus as in index
                //  into the vector table pointer to by the I register.
                this.push_word(this.pc);
                // The Z80 manual says that this address must be 2-byte aligned,
                //  but it doesn't appear that this is actually the case on the hardware,
                //  so we don't attempt to enforce that here.
                var vector_address = ((this.i << 8) | data);
                this.pc = this.core.read_mem_byte(vector_address) |
                    (this.core.read_mem_byte((vector_address + 1) & 0xffff) << 8);

                this.cycle_counter += 19;
            }
        }
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// The private API functions end here.
    ///
    /// What begins here are just general utility functions, used variously.
    ///////////////////////////////////////////////////////////////////////////////
    private decode_instruction(opcode) {
        // The register-to-register loads and ALU instructions
        //  are all so uniform that we can decode them directly
        //  instead of going into the instruction array for them.
        // This function gets the operand for all of these instructions.
        var get_operand = function (opcode) {
            return ((opcode & 0x07) === 0) ? this.b :
                ((opcode & 0x07) === 1) ? this.c :
                    ((opcode & 0x07) === 2) ? this.d :
                        ((opcode & 0x07) === 3) ? this.e :
                            ((opcode & 0x07) === 4) ? this.h :
                                ((opcode & 0x07) === 5) ? this.l :
                                    ((opcode & 0x07) === 6) ? this.core.mem_read(this.l | (this.h << 8)) : this.a;
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
            var operand = get_operand.call(this, opcode);

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
                this.core.mem_write(this.l | (this.h << 8), operand);
            else if (((opcode & 0x38) >>> 3) === 7)
                this.a = operand;
        }
        else if ((opcode >= 0x80) && (opcode < 0xc0)) {
            // These are the 8-bit register ALU instructions.
            // We'll get the operand and then use this "jump table"
            //  to call the correct utility function for the instruction.
            var operand = get_operand.call(this, opcode),
                op_array = [this.do_add, this.do_adc, this.do_sub, this.do_sbc,
                this.do_and, this.do_xor, this.do_or, this.do_cp];

            op_array[(opcode & 0x38) >>> 3].call(this, operand);
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
        this.cycle_counter += this.cycle_counts[opcode];
    };

    private get_signed_offset_byte(value) {
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

    private get_flags_register() {
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

    private get_flags_alt() {
        // This is the same as the above for the F' register.
        return (this.flags_alt.S << 7) |
            (this.flags_alt.Z << 6) |
            (this.flags_alt.Y << 5) |
            (this.flags_alt.H << 4) |
            (this.flags_alt.X << 3) |
            (this.flags_alt.P << 2) |
            (this.flags_alt.N << 1) |
            (this.flags_alt.C);
    };

    private set_flags_register(operand) {
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

    private set_flags_alt(operand) {
        // Again, this is the same as the above for F'.
        this.flags_alt.S = (operand & 0x80) >>> 7;
        this.flags_alt.Z = (operand & 0x40) >>> 6;
        this.flags_alt.Y = (operand & 0x20) >>> 5;
        this.flags_alt.H = (operand & 0x10) >>> 4;
        this.flags_alt.X = (operand & 0x08) >>> 3;
        this.flags_alt.P = (operand & 0x04) >>> 2;
        this.flags_alt.N = (operand & 0x02) >>> 1;
        this.flags_alt.C = (operand & 0x01);
    };

    private update_xy_flags(result) {
        // Most of the time, the undocumented flags
        //  (sometimes called X and Y, or 3 and 5),
        //  take their values from the corresponding bits
        //  of the result of the instruction,
        //  or from some other related value.
        // This is a utility function to set those flags based on those bits.
        this.flags.Y = (result & 0x20) >>> 5;
        this.flags.X = (result & 0x08) >>> 3;
    };

    private get_parity(value) {
        // We could try to actually calculate the parity every time,
        //  but why calculate what you can pre-calculate?
        var parity_bits = [
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
        return parity_bits[value];
    };

    private push_word(operand) {
        // Pretty obvious what this function does; given a 16-bit value,
        //  decrement the stack pointer, write the high byte to the new
        //  stack pointer location, then repeat for the low byte.
        this.sp = (this.sp - 1) & 0xffff;
        this.core.mem_write(this.sp, (operand & 0xff00) >>> 8);
        this.sp = (this.sp - 1) & 0xffff;
        this.core.mem_write(this.sp, operand & 0x00ff);
    };

    private pop_word() {
        // Again, not complicated; read a byte off the top of the stack,
        //  increment the stack pointer, rinse and repeat.
        var retval = this.core.mem_read(this.sp) & 0xff;
        this.sp = (this.sp + 1) & 0xffff;
        retval |= this.core.mem_read(this.sp) << 8;
        this.sp = (this.sp + 1) & 0xffff;
        return retval;
    };

    ///////////////////////////////////////////////////////////////////////////////
    /// Now, the way most instructions work in this emulator is that they set up
    ///  their operands according to their addressing mode, and then they call a
    ///  utility function that handles all variations of that instruction.
    /// Those utility functions begin here.
    ///////////////////////////////////////////////////////////////////////////////
    private do_conditional_absolute_jump(condition) {
        // This function implements the JP [condition],nn instructions.
        if (condition) {
            // We're taking this jump, so write the new PC,
            //  and then decrement the thing we just wrote,
            //  because the instruction decoder increments the PC
            //  unconditionally at the end of every instruction
            //  and we need to counteract that so we end up at the jump target.
            this.pc = this.core.mem_read((this.pc + 1) & 0xffff) |
                (this.core.mem_read((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        }
        else {
            // We're not taking this jump, just move the PC past the operand.
            this.pc = (this.pc + 2) & 0xffff;
        }
    };

    private do_conditional_relative_jump(condition) {
        // This function implements the JR [condition],n instructions.
        if (condition) {
            // We need a few more cycles to actually take the jump.
            this.cycle_counter += 5;
            // Calculate the offset specified by our operand.
            var offset = this.get_signed_offset_byte(this.core.mem_read((this.pc + 1) & 0xffff));
            // Add the offset to the PC, also skipping past this instruction.
            this.pc = (this.pc + offset + 1) & 0xffff;
        }
        else {
            // No jump happening, just skip the operand.
            this.pc = (this.pc + 1) & 0xffff;
        }
    };

    private do_conditional_call(condition) {
        // This function is the CALL [condition],nn instructions.
        // If you've seen the previous functions, you know this drill.
        if (condition) {
            this.cycle_counter += 7;
            this.push_word((this.pc + 3) & 0xffff);
            this.pc = this.core.mem_read((this.pc + 1) & 0xffff) |
                (this.core.mem_read((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        }
        else {
            this.pc = (this.pc + 2) & 0xffff;
        }
    };

    private do_conditional_return(condition) {
        if (condition) {
            this.cycle_counter += 6;
            this.pc = (this.pop_word() - 1) & 0xffff;
        }
    };

    private do_reset(address) {
        // The RST [address] instructions go through here.
        this.push_word((this.pc + 1) & 0xffff);
        this.pc = (address - 1) & 0xffff;
    };

    private do_add(operand) {
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
        this.update_xy_flags(this.a);
    };

    private do_adc(operand) {
        var result = this.a + operand + this.flags.C;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((operand & 0x0f) + (this.a & 0x0f) + this.flags.C) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) === (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 0;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.update_xy_flags(this.a);
    };

    private do_sub(operand) {
        var result = this.a - operand;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((this.a & 0x0f) - (operand & 0x0f)) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) !== (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.update_xy_flags(this.a);
    };

    private do_sbc(operand) {
        var result = this.a - operand - this.flags.C;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = (((this.a & 0x0f) - (operand & 0x0f) - this.flags.C) & 0x10) ? 1 : 0;
        this.flags.P = ((this.a & 0x80) !== (operand & 0x80)) && ((this.a & 0x80) !== (result & 0x80)) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = (result & 0x100) ? 1 : 0;

        this.a = result & 0xff;
        this.update_xy_flags(this.a);
    };

    private do_cp(operand) {
        // A compare instruction is just a subtraction that doesn't save the value,
        //  so we implement it as... a subtraction that doesn't save the value.
        var temp = this.a;
        this.do_sub(operand);
        this.a = temp;
        // Since this instruction has no "result" value, the undocumented flags
        //  are set based on the operand instead.
        this.update_xy_flags(operand);
    };

    private do_and(operand) {
        // The logic instructions are all pretty straightforward.
        this.a &= operand & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 1;
        this.flags.P = this.get_parity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.update_xy_flags(this.a);
    };

    private do_or(operand) {
        this.a = (operand | this.a) & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 0;
        this.flags.P = this.get_parity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.update_xy_flags(this.a);
    };

    private do_xor(operand) {
        this.a = (operand ^ this.a) & 0xff;
        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = 0;
        this.flags.P = this.get_parity(this.a);
        this.flags.N = 0;
        this.flags.C = 0;
        this.update_xy_flags(this.a);
    };

    private do_inc(operand) {
        var result = operand + 1;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = ((operand & 0x0f) === 0x0f) ? 1 : 0;
        // It's a good deal easier to detect overflow for an increment/decrement.
        this.flags.P = (operand === 0x7f) ? 1 : 0;
        this.flags.N = 0;

        result &= 0xff;
        this.update_xy_flags(result);

        return result;
    };

    private do_dec(operand) {
        var result = operand - 1;

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = !(result & 0xff) ? 1 : 0;
        this.flags.H = ((operand & 0x0f) === 0x00) ? 1 : 0;
        this.flags.P = (operand === 0x80) ? 1 : 0;
        this.flags.N = 1;

        result &= 0xff;
        this.update_xy_flags(result);

        return result;
    };

    private do_hl_add(operand) {
        // The HL arithmetic instructions are the same as the A ones,
        //  just with twice as many bits happening.
        var hl = this.l | (this.h << 8), result = hl + operand;

        this.flags.N = 0;
        this.flags.C = (result & 0x10000) ? 1 : 0;
        this.flags.H = (((hl & 0x0fff) + (operand & 0x0fff)) & 0x1000) ? 1 : 0;

        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.update_xy_flags(this.h);
    };

    private do_hl_adc(operand) {
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

        this.update_xy_flags(this.h);
    };

    private do_hl_sbc(operand) {
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

        this.update_xy_flags(this.h);
    };

    private do_in(port) {
        var result = this.core.io_read(port);

        this.flags.S = (result & 0x80) ? 1 : 0;
        this.flags.Z = result ? 0 : 1;
        this.flags.H = 0;
        this.flags.P = this.get_parity(result) ? 1 : 0;
        this.flags.N = 0;
        this.update_xy_flags(result);

        return result;
    };

    private do_neg() {
        // This instruction is defined to not alter the register if it === 0x80.
        if (this.a !== 0x80) {
            // This is a signed operation, so convert A to a signed value.
            this.a = this.get_signed_offset_byte(this.a);

            this.a = (-this.a) & 0xff;
        }

        this.flags.S = (this.a & 0x80) ? 1 : 0;
        this.flags.Z = !this.a ? 1 : 0;
        this.flags.H = (((-this.a) & 0x0f) > 0) ? 1 : 0;
        this.flags.P = (this.a === 0x80) ? 1 : 0;
        this.flags.N = 1;
        this.flags.C = this.a ? 1 : 0;
        this.update_xy_flags(this.a);
    };

    private do_ldi() {
        // Copy the value that we're supposed to copy.
        var read_value = this.core.mem_read(this.l | (this.h << 8));
        this.core.mem_write(this.e | (this.d << 8), read_value);

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
        this.flags.Y = ((this.a + read_value) & 0x02) >>> 1;
        this.flags.X = ((this.a + read_value) & 0x08) >>> 3;
    };

    private do_cpi() {
        var temp_carry = this.flags.C;
        var read_value = this.core.mem_read(this.l | (this.h << 8))
        this.do_cp(read_value);
        this.flags.C = temp_carry;
        this.flags.Y = ((this.a - read_value - this.flags.H) & 0x02) >>> 1;
        this.flags.X = ((this.a - read_value - this.flags.H) & 0x08) >>> 3;

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.P = result ? 1 : 0;
    };

    private do_ini() {
        this.b = this.do_dec(this.b);

        this.core.mem_write(this.l | (this.h << 8), this.core.io_read((this.b << 8) | this.c));

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.flags.N = 1;
    };

    private do_outi() {
        this.core.io_write((this.b << 8) | this.c, this.core.mem_read(this.l | (this.h << 8)));

        var result = (this.l | (this.h << 8)) + 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.b = this.do_dec(this.b);
        this.flags.N = 1;
    };

    private do_ldd() {
        this.flags.N = 0;
        this.flags.H = 0;

        var read_value = this.core.mem_read(this.l | (this.h << 8));
        this.core.mem_write(this.e | (this.d << 8), read_value);

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
        this.flags.Y = ((this.a + read_value) & 0x02) >>> 1;
        this.flags.X = ((this.a + read_value) & 0x08) >>> 3;
    };

    private do_cpd() {
        var temp_carry = this.flags.C
        var read_value = this.core.mem_read(this.l | (this.h << 8))
        this.do_cp(read_value);
        this.flags.C = temp_carry;
        this.flags.Y = ((this.a - read_value - this.flags.H) & 0x02) >>> 1;
        this.flags.X = ((this.a - read_value - this.flags.H) & 0x08) >>> 3;

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;
        result = (this.c | (this.b << 8)) - 1;
        this.c = result & 0xff;
        this.b = (result & 0xff00) >>> 8;

        this.flags.P = result ? 1 : 0;
    };

    private do_ind() {
        this.b = this.do_dec(this.b);

        this.core.mem_write(this.l | (this.h << 8), this.core.io_read((this.b << 8) | this.c));

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.flags.N = 1;
    };

    private do_outd() {
        this.core.io_write((this.b << 8) | this.c, this.core.mem_read(this.l | (this.h << 8)));

        var result = (this.l | (this.h << 8)) - 1;
        this.l = result & 0xff;
        this.h = (result & 0xff00) >>> 8;

        this.b = this.do_dec(this.b);
        this.flags.N = 1;
    };

    private do_rlc(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) | this.flags.C) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_rrc(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (this.flags.C << 7);

        this.flags.Z = !(operand & 0xff) ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand & 0xff;
    };

    private do_rl(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        var temp = this.flags.C;
        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) | temp) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_rr(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        var temp = this.flags.C;
        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (temp << 7);

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_sla(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = (operand << 1) & 0xff;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_sra(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = ((operand >>> 1) & 0x7f) | (operand & 0x80);

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_sll(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = (operand & 0x80) >>> 7;
        operand = ((operand << 1) & 0xff) | 1;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = (operand & 0x80) ? 1 : 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_srl(operand) {
        this.flags.N = 0;
        this.flags.H = 0;

        this.flags.C = operand & 1;
        operand = (operand >>> 1) & 0x7f;

        this.flags.Z = !operand ? 1 : 0;
        this.flags.P = this.get_parity(operand);
        this.flags.S = 0;
        this.update_xy_flags(operand);

        return operand;
    };

    private do_ix_add(operand) {
        this.flags.N = 0;

        var result = this.ix + operand;

        this.flags.C = (result & 0x10000) ? 1 : 0;
        this.flags.H = (((this.ix & 0xfff) + (operand & 0xfff)) & 0x1000) ? 1 : 0;
        this.update_xy_flags((result & 0xff00) >>> 8);

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
            this.c = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.b = this.core.mem_read(this.pc);
        };
        // 0x02 : LD (BC), A
        this.instructions[0x02] = () => {
            this.core.mem_write(this.c | (this.b << 8), this.a);
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
            this.b = this.do_inc(this.b);
        };
        // 0x05 : DEC B
        this.instructions[0x05] = () => {
            this.b = this.do_dec(this.b);
        };
        // 0x06 : LD B, n
        this.instructions[0x06] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.b = this.core.mem_read(this.pc);
        };
        // 0x07 : RLCA
        this.instructions[0x07] = () => {
            // This instruction is implemented as a special case of the
            //  more general Z80-specific RLC instruction.
            // Specifially, RLCA is a version of RLC A that affects fewer flags.
            // The same applies to RRCA, RLA, and RRA.
            var temp_s = this.flags.S, temp_z = this.flags.Z, temp_p = this.flags.P;
            this.a = this.do_rlc(this.a);
            this.flags.S = temp_s;
            this.flags.Z = temp_z;
            this.flags.P = temp_p;
        };
        // 0x08 : EX AF, AF'
        this.instructions[0x08] = () => {
            var temp = this.a;
            this.a = this.a_alt;
            this.a_alt = temp;

            temp = this.get_flags_register();
            this.set_flags_register(this.get_flags_alt());
            this.set_flags_alt(temp);
        };
        // 0x09 : ADD HL, BC
        this.instructions[0x09] = () => {
            this.do_hl_add(this.c | (this.b << 8));
        };
        // 0x0a : LD A, (BC)
        this.instructions[0x0a] = () => {
            this.a = this.core.mem_read(this.c | (this.b << 8));
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
            this.c = this.do_inc(this.c);
        };
        // 0x0d : DEC C
        this.instructions[0x0d] = () => {
            this.c = this.do_dec(this.c);
        };
        // 0x0e : LD C, n
        this.instructions[0x0e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.c = this.core.mem_read(this.pc);
        };
        // 0x0f : RRCA
        this.instructions[0x0f] = () => {
            var temp_s = this.flags.S, temp_z = this.flags.Z, temp_p = this.flags.P;
            this.a = this.do_rrc(this.a);
            this.flags.S = temp_s;
            this.flags.Z = temp_z;
            this.flags.P = temp_p;
        };
        // 0x10 : DJNZ nn
        this.instructions[0x10] = () => {
            this.b = (this.b - 1) & 0xff;
            this.do_conditional_relative_jump(this.b !== 0);
        };
        // 0x11 : LD DE, nn
        this.instructions[0x11] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.e = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.d = this.core.mem_read(this.pc);
        };
        // 0x12 : LD (DE), A
        this.instructions[0x12] = () => {
            this.core.mem_write(this.e | (this.d << 8), this.a);
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
            this.d = this.do_inc(this.d);
        };
        // 0x15 : DEC D
        this.instructions[0x15] = () => {
            this.d = this.do_dec(this.d);
        };
        // 0x16 : LD D, n
        this.instructions[0x16] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.d = this.core.mem_read(this.pc);
        };
        // 0x17 : RLA
        this.instructions[0x17] = () => {
            var temp_s = this.flags.S, temp_z = this.flags.Z, temp_p = this.flags.P;
            this.a = this.do_rl(this.a);
            this.flags.S = temp_s;
            this.flags.Z = temp_z;
            this.flags.P = temp_p;
        };
        // 0x18 : JR n
        this.instructions[0x18] = () => {
            var offset = this.get_signed_offset_byte(this.core.mem_read((this.pc + 1) & 0xffff));
            this.pc = (this.pc + offset + 1) & 0xffff;
        };
        // 0x19 : ADD HL, DE
        this.instructions[0x19] = () => {
            this.do_hl_add(this.e | (this.d << 8));
        };
        // 0x1a : LD A, (DE)
        this.instructions[0x1a] = () => {
            this.a = this.core.mem_read(this.e | (this.d << 8));
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
            this.e = this.do_inc(this.e);
        };
        // 0x1d : DEC E
        this.instructions[0x1d] = () => {
            this.e = this.do_dec(this.e);
        };
        // 0x1e : LD E, n
        this.instructions[0x1e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.e = this.core.mem_read(this.pc);
        };
        // 0x1f : RRA
        this.instructions[0x1f] = () => {
            var temp_s = this.flags.S, temp_z = this.flags.Z, temp_p = this.flags.P;
            this.a = this.do_rr(this.a);
            this.flags.S = temp_s;
            this.flags.Z = temp_z;
            this.flags.P = temp_p;
        };
        // 0x20 : JR NZ, n
        this.instructions[0x20] = () => {
            this.do_conditional_relative_jump(!this.flags.Z);
        };
        // 0x21 : LD HL, nn
        this.instructions[0x21] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.l = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.h = this.core.mem_read(this.pc);
        };
        // 0x22 : LD (nn), HL
        this.instructions[0x22] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.l);
            this.core.mem_write((address + 1) & 0xffff, this.h);
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
            this.h = this.do_inc(this.h);
        };
        // 0x25 : DEC H
        this.instructions[0x25] = () => {
            this.h = this.do_dec(this.h);
        };
        // 0x26 : LD H, n
        this.instructions[0x26] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.h = this.core.mem_read(this.pc);
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
            this.flags.P = this.get_parity(temp & 0xff);
            // DAA never clears the carry flag if it was already set,
            //  but it is able to set the carry flag if it was clear.
            // Don't ask me, I don't know.
            // Note also that we check for a BCD carry, instead of the usual.
            this.flags.C = (this.flags.C || (this.a > 0x99)) ? 1 : 0;

            this.a = temp & 0xff;

            this.update_xy_flags(this.a);
        };
        // 0x28 : JR Z, n
        this.instructions[0x28] = () => {
            this.do_conditional_relative_jump(!!this.flags.Z);
        };
        // 0x29 : ADD HL, HL
        this.instructions[0x29] = () => {
            this.do_hl_add(this.l | (this.h << 8));
        };
        // 0x2a : LD HL, (nn)
        this.instructions[0x2a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.l = this.core.mem_read(address);
            this.h = this.core.mem_read((address + 1) & 0xffff);
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
            this.l = this.do_inc(this.l);
        };
        // 0x2d : DEC L
        this.instructions[0x2d] = () => {
            this.l = this.do_dec(this.l);
        };
        // 0x2e : LD L, n
        this.instructions[0x2e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.l = this.core.mem_read(this.pc);
        };
        // 0x2f : CPL
        this.instructions[0x2f] = () => {
            this.a = (~this.a) & 0xff;
            this.flags.N = 1;
            this.flags.H = 1;
            this.update_xy_flags(this.a);
        };
        // 0x30 : JR NC, n
        this.instructions[0x30] = () => {
            this.do_conditional_relative_jump(!this.flags.C);
        };
        // 0x31 : LD SP, nn
        this.instructions[0x31] = () => {
            this.sp = this.core.mem_read((this.pc + 1) & 0xffff) |
                (this.core.mem_read((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc + 2) & 0xffff;
        };
        // 0x32 : LD (nn), A
        this.instructions[0x32] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.a);
        };
        // 0x33 : INC SP
        this.instructions[0x33] = () => {
            this.sp = (this.sp + 1) & 0xffff;
        };
        // 0x34 : INC (HL)
        this.instructions[0x34] = () => {
            var address = this.l | (this.h << 8);
            this.core.mem_write(address, this.do_inc(this.core.mem_read(address)));
        };
        // 0x35 : DEC (HL)
        this.instructions[0x35] = () => {
            var address = this.l | (this.h << 8);
            this.core.mem_write(address, this.do_dec(this.core.mem_read(address)));
        };
        // 0x36 : LD (HL), n
        this.instructions[0x36] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.core.mem_write(this.l | (this.h << 8), this.core.mem_read(this.pc));
        };
        // 0x37 : SCF
        this.instructions[0x37] = () => {
            this.flags.N = 0;
            this.flags.H = 0;
            this.flags.C = 1;
            this.update_xy_flags(this.a);
        };
        // 0x38 : JR C, n
        this.instructions[0x38] = () => {
            this.do_conditional_relative_jump(!!this.flags.C);
        };
        // 0x39 : ADD HL, SP
        this.instructions[0x39] = () => {
            this.do_hl_add(this.sp);
        };
        // 0x3a : LD A, (nn)
        this.instructions[0x3a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.a = this.core.mem_read(address);
        };
        // 0x3b : DEC SP
        this.instructions[0x3b] = () => {
            this.sp = (this.sp - 1) & 0xffff;
        };
        // 0x3c : INC A
        this.instructions[0x3c] = () => {
            this.a = this.do_inc(this.a);
        };
        // 0x3d : DEC A
        this.instructions[0x3d] = () => {
            this.a = this.do_dec(this.a);
        };
        // 0x3e : LD A, n
        this.instructions[0x3e] = () => {
            this.a = this.core.mem_read((this.pc + 1) & 0xffff);
            this.pc = (this.pc + 1) & 0xffff;
        };
        // 0x3f : CCF
        this.instructions[0x3f] = () => {
            this.flags.N = 0;
            this.flags.H = this.flags.C;
            this.flags.C = this.flags.C ? 0 : 1;
            this.update_xy_flags(this.a);
        };
        // 0xc0 : RET NZ
        this.instructions[0xc0] = () => {
            this.do_conditional_return(!this.flags.Z);
        };
        // 0xc1 : POP BC
        this.instructions[0xc1] = () => {
            var result = this.pop_word();
            this.c = result & 0xff;
            this.b = (result & 0xff00) >>> 8;
        };
        // 0xc2 : JP NZ, nn
        this.instructions[0xc2] = () => {
            this.do_conditional_absolute_jump(!this.flags.Z);
        };
        // 0xc3 : JP nn
        this.instructions[0xc3] = () => {
            this.pc = this.core.mem_read((this.pc + 1) & 0xffff) |
                (this.core.mem_read((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xc4 : CALL NZ, nn
        this.instructions[0xc4] = () => {
            this.do_conditional_call(!this.flags.Z);
        };
        // 0xc5 : PUSH BC
        this.instructions[0xc5] = () => {
            this.push_word(this.c | (this.b << 8));
        };
        // 0xc6 : ADD A, n
        this.instructions[0xc6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_add(this.core.mem_read(this.pc));
        };
        // 0xc7 : RST 00h
        this.instructions[0xc7] = () => {
            this.do_reset(0x00);
        };
        // 0xc8 : RET Z
        this.instructions[0xc8] = () => {
            this.do_conditional_return(!!this.flags.Z);
        };
        // 0xc9 : RET
        this.instructions[0xc9] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
        };
        // 0xca : JP Z, nn
        this.instructions[0xca] = () => {
            this.do_conditional_absolute_jump(!!this.flags.Z);
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
            var opcode = this.core.mem_read(this.pc),
                bit_number = (opcode & 0x38) >>> 3,
                reg_code = opcode & 0x07;

            if (opcode < 0x40) {
                // Shift/rotate instructions
                var op_array = [this.do_rlc, this.do_rrc, this.do_rl, this.do_rr,
                this.do_sla, this.do_sra, this.do_sll, this.do_srl];

                if (reg_code === 0)
                    this.b = op_array[bit_number].call(this, this.b);
                else if (reg_code === 1)
                    this.c = op_array[bit_number].call(this, this.c);
                else if (reg_code === 2)
                    this.d = op_array[bit_number].call(this, this.d);
                else if (reg_code === 3)
                    this.e = op_array[bit_number].call(this, this.e);
                else if (reg_code === 4)
                    this.h = op_array[bit_number].call(this, this.h);
                else if (reg_code === 5)
                    this.l = op_array[bit_number].call(this, this.l);
                else if (reg_code === 6)
                    this.core.mem_write(this.l | (this.h << 8),
                        op_array[bit_number].call(this, this.core.mem_read(this.l | (this.h << 8))));
                else if (reg_code === 7)
                    this.a = op_array[bit_number].call(this, this.a);
            }
            else if (opcode < 0x80) {
                // BIT instructions
                if (reg_code === 0)
                    this.flags.Z = !(this.b & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 1)
                    this.flags.Z = !(this.c & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 2)
                    this.flags.Z = !(this.d & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 3)
                    this.flags.Z = !(this.e & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 4)
                    this.flags.Z = !(this.h & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 5)
                    this.flags.Z = !(this.l & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 6)
                    this.flags.Z = !((this.core.mem_read(this.l | (this.h << 8))) & (1 << bit_number)) ? 1 : 0;
                else if (reg_code === 7)
                    this.flags.Z = !(this.a & (1 << bit_number)) ? 1 : 0;

                this.flags.N = 0;
                this.flags.H = 1;
                this.flags.P = this.flags.Z;
                this.flags.S = ((bit_number === 7) && !this.flags.Z) ? 1 : 0;
                // For the BIT n, (HL) instruction, the X and Y flags are obtained
                //  from what is apparently an internal temporary register used for
                //  some of the 16-bit arithmetic instructions.
                // I haven't implemented that register here,
                //  so for now we'll set X and Y the same way for every BIT opcode,
                //  which means that they will usually be wrong for BIT n, (HL).
                this.flags.Y = ((bit_number === 5) && !this.flags.Z) ? 1 : 0;
                this.flags.X = ((bit_number === 3) && !this.flags.Z) ? 1 : 0;
            }
            else if (opcode < 0xc0) {
                // RES instructions
                if (reg_code === 0)
                    this.b &= (0xff & ~(1 << bit_number));
                else if (reg_code === 1)
                    this.c &= (0xff & ~(1 << bit_number));
                else if (reg_code === 2)
                    this.d &= (0xff & ~(1 << bit_number));
                else if (reg_code === 3)
                    this.e &= (0xff & ~(1 << bit_number));
                else if (reg_code === 4)
                    this.h &= (0xff & ~(1 << bit_number));
                else if (reg_code === 5)
                    this.l &= (0xff & ~(1 << bit_number));
                else if (reg_code === 6)
                    this.core.mem_write(this.l | (this.h << 8),
                        this.core.mem_read(this.l | (this.h << 8)) & ~(1 << bit_number));
                else if (reg_code === 7)
                    this.a &= (0xff & ~(1 << bit_number));
            }
            else {
                // SET instructions
                if (reg_code === 0)
                    this.b |= (1 << bit_number);
                else if (reg_code === 1)
                    this.c |= (1 << bit_number);
                else if (reg_code === 2)
                    this.d |= (1 << bit_number);
                else if (reg_code === 3)
                    this.e |= (1 << bit_number);
                else if (reg_code === 4)
                    this.h |= (1 << bit_number);
                else if (reg_code === 5)
                    this.l |= (1 << bit_number);
                else if (reg_code === 6)
                    this.core.mem_write(this.l | (this.h << 8),
                        this.core.mem_read(this.l | (this.h << 8)) | (1 << bit_number));
                else if (reg_code === 7)
                    this.a |= (1 << bit_number);
            }

            this.cycle_counter += this.cycle_counts_cb[opcode];
        };
        // 0xcc : CALL Z, nn
        this.instructions[0xcc] = () => {
            this.do_conditional_call(!!this.flags.Z);
        };
        // 0xcd : CALL nn
        this.instructions[0xcd] = () => {
            this.push_word((this.pc + 3) & 0xffff);
            this.pc = this.core.mem_read((this.pc + 1) & 0xffff) |
                (this.core.mem_read((this.pc + 2) & 0xffff) << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xce : ADC A, n
        this.instructions[0xce] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_adc(this.core.mem_read(this.pc));
        };
        // 0xcf : RST 08h
        this.instructions[0xcf] = () => {
            this.do_reset(0x08);
        };
        // 0xd0 : RET NC
        this.instructions[0xd0] = () => {
            this.do_conditional_return(!this.flags.C);
        };
        // 0xd1 : POP DE
        this.instructions[0xd1] = () => {
            var result = this.pop_word();
            this.e = result & 0xff;
            this.d = (result & 0xff00) >>> 8;
        };
        // 0xd2 : JP NC, nn
        this.instructions[0xd2] = () => {
            this.do_conditional_absolute_jump(!this.flags.C);
        };
        // 0xd3 : OUT (n), A
        this.instructions[0xd3] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.core.io_write((this.a << 8) | this.core.mem_read(this.pc), this.a);
        };
        // 0xd4 : CALL NC, nn
        this.instructions[0xd4] = () => {
            this.do_conditional_call(!this.flags.C);
        };
        // 0xd5 : PUSH DE
        this.instructions[0xd5] = () => {
            this.push_word(this.e | (this.d << 8));
        };
        // 0xd6 : SUB n
        this.instructions[0xd6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_sub(this.core.mem_read(this.pc));
        };
        // 0xd7 : RST 10h
        this.instructions[0xd7] = () => {
            this.do_reset(0x10);
        };
        // 0xd8 : RET C
        this.instructions[0xd8] = () => {
            this.do_conditional_return(!!this.flags.C);
        };
        // 0xd9 : EXX
        this.instructions[0xd9] = () => {
            var temp = this.b;
            this.b = this.b_alt;
            this.b_alt = temp;
            temp = this.c;
            this.c = this.c_alt;
            this.c_alt = temp;
            temp = this.d;
            this.d = this.d_alt;
            this.d_alt = temp;
            temp = this.e;
            this.e = this.e_alt;
            this.e_alt = temp;
            temp = this.h;
            this.h = this.h_alt;
            this.h_alt = temp;
            temp = this.l;
            this.l = this.l_alt;
            this.l_alt = temp;
        };
        // 0xda : JP C, nn
        this.instructions[0xda] = () => {
            this.do_conditional_absolute_jump(!!this.flags.C);
        };
        // 0xdb : IN A, (n)
        this.instructions[0xdb] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.a = this.core.io_read((this.a << 8) | this.core.mem_read(this.pc));
        };
        // 0xdc : CALL C, nn
        this.instructions[0xdc] = () => {
            this.do_conditional_call(!!this.flags.C);
        };
        // 0xdd : DD Prefix (IX instructions)
        this.instructions[0xdd] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.mem_read(this.pc),
                func = this.dd_instructions[opcode];

            if (func) {
                func();
                this.cycle_counter += this.cycle_counts_dd[opcode];
            }
            else {
                // Apparently if a DD opcode doesn't exist,
                //  it gets treated as an unprefixed opcode.
                // What we'll do to handle that is just back up the 
                //  program counter, so that this byte gets decoded
                //  as a normal instruction.
                this.pc = (this.pc - 1) & 0xffff;
                // And we'll add in the cycle count for a NOP.
                this.cycle_counter += this.cycle_counts[0];
            }
        };
        // 0xde : SBC n
        this.instructions[0xde] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_sbc(this.core.mem_read(this.pc));
        };
        // 0xdf : RST 18h
        this.instructions[0xdf] = () => {
            this.do_reset(0x18);
        };
        // 0xe0 : RET PO
        this.instructions[0xe0] = () => {
            this.do_conditional_return(!this.flags.P);
        };
        // 0xe1 : POP HL
        this.instructions[0xe1] = () => {
            var result = this.pop_word();
            this.l = result & 0xff;
            this.h = (result & 0xff00) >>> 8;
        };
        // 0xe2 : JP PO, (nn)
        this.instructions[0xe2] = () => {
            this.do_conditional_absolute_jump(!this.flags.P);
        };
        // 0xe3 : EX (SP), HL
        this.instructions[0xe3] = () => {
            var temp = this.core.mem_read(this.sp);
            this.core.mem_write(this.sp, this.l);
            this.l = temp;
            temp = this.core.mem_read((this.sp + 1) & 0xffff);
            this.core.mem_write((this.sp + 1) & 0xffff, this.h);
            this.h = temp;
        };
        // 0xe4 : CALL PO, nn
        this.instructions[0xe4] = () => {
            this.do_conditional_call(!this.flags.P);
        };
        // 0xe5 : PUSH HL
        this.instructions[0xe5] = () => {
            this.push_word(this.l | (this.h << 8));
        };
        // 0xe6 : AND n
        this.instructions[0xe6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_and(this.core.mem_read(this.pc));
        };
        // 0xe7 : RST 20h
        this.instructions[0xe7] = () => {
            this.do_reset(0x20);
        };
        // 0xe8 : RET PE
        this.instructions[0xe8] = () => {
            this.do_conditional_return(!!this.flags.P);
        };
        // 0xe9 : JP (HL)
        this.instructions[0xe9] = () => {
            this.pc = this.l | (this.h << 8);
            this.pc = (this.pc - 1) & 0xffff;
        };
        // 0xea : JP PE, nn
        this.instructions[0xea] = () => {
            this.do_conditional_absolute_jump(!!this.flags.P);
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
            this.do_conditional_call(!!this.flags.P);
        };
        // 0xed : ED Prefix
        this.instructions[0xed] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.mem_read(this.pc),
                func = this.ed_instructions[opcode];

            if (func) {
                func();
                this.cycle_counter += this.cycle_counts_ed[opcode];
            }
            else {
                // If the opcode didn't exist, the whole thing is a two-byte NOP.
                this.cycle_counter += this.cycle_counts[0];
            }
        };
        // 0xee : XOR n
        this.instructions[0xee] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_xor(this.core.mem_read(this.pc));
        };
        // 0xef : RST 28h
        this.instructions[0xef] = () => {
            this.do_reset(0x28);
        };
        // 0xf0 : RET P
        this.instructions[0xf0] = () => {
            this.do_conditional_return(!this.flags.S);
        };
        // 0xf1 : POP AF
        this.instructions[0xf1] = () => {
            var result = this.pop_word();
            this.set_flags_register(result & 0xff);
            this.a = (result & 0xff00) >>> 8;
        };
        // 0xf2 : JP P, nn
        this.instructions[0xf2] = () => {
            this.do_conditional_absolute_jump(!this.flags.S);
        };
        // 0xf3 : DI
        this.instructions[0xf3] = () => {
            // DI doesn't actually take effect until after the next instruction.
            this.do_delayed_di = true;
        };
        // 0xf4 : CALL P, nn
        this.instructions[0xf4] = () => {
            this.do_conditional_call(!this.flags.S);
        };
        // 0xf5 : PUSH AF
        this.instructions[0xf5] = () => {
            this.push_word(this.get_flags_register() | (this.a << 8));
        };
        // 0xf6 : OR n
        this.instructions[0xf6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_or(this.core.mem_read(this.pc));
        };
        // 0xf7 : RST 30h
        this.instructions[0xf7] = () => {
            this.do_reset(0x30);
        };
        // 0xf8 : RET M
        this.instructions[0xf8] = () => {
            this.do_conditional_return(!!this.flags.S);
        };
        // 0xf9 : LD SP, HL
        this.instructions[0xf9] = () => {
            this.sp = this.l | (this.h << 8);
        };
        // 0xfa : JP M, nn
        this.instructions[0xfa] = () => {
            this.do_conditional_absolute_jump(!!this.flags.S);
        };
        // 0xfb : EI
        this.instructions[0xfb] = () => {
            // EI doesn't actually take effect until after the next instruction.
            this.do_delayed_ei = true;
        };
        // 0xfc : CALL M, nn
        this.instructions[0xfc] = () => {
            this.do_conditional_call(!!this.flags.S);
        };
        // 0xfd : FD Prefix (IY instructions)
        this.instructions[0xfd] = () => {
            // R is incremented at the start of the second instruction cycle,
            //  before the instruction actually runs.
            // The high bit of R is not affected by this increment,
            //  it can only be changed using the LD R, A instruction.
            this.r = (this.r & 0x80) | (((this.r & 0x7f) + 1) & 0x7f);

            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.mem_read(this.pc),
                func = this.dd_instructions[opcode];

            if (func) {
                // Rather than copy and paste all the IX instructions into IY instructions,
                //  what we'll do is sneakily copy IY into IX, run the IX instruction,
                //  and then copy the result into IY and restore the old IX.
                var temp = this.ix;
                this.ix = this.iy;
                func();
                this.iy = this.ix;
                this.ix = temp;

                this.cycle_counter += this.cycle_counts_dd[opcode];
            }
            else {
                // Apparently if an FD opcode doesn't exist,
                //  it gets treated as an unprefixed opcode.
                // What we'll do to handle that is just back up the 
                //  program counter, so that this byte gets decoded
                //  as a normal instruction.
                this.pc = (this.pc - 1) & 0xffff;
                // And we'll add in the cycle count for a NOP.
                this.cycle_counter += this.cycle_counts[0];
            }
        };
        // 0xfe : CP n
        this.instructions[0xfe] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.do_cp(this.core.mem_read(this.pc));
        };
        // 0xff : RST 38h
        this.instructions[0xff] = () => {
            this.do_reset(0x38);
        };
    }


    ///////////////////////////////////////////////////////////////////////////////
    /// This table of ED opcodes is pretty sparse;
    ///  there are not very many valid ED-prefixed opcodes in the Z80,
    ///  and many of the ones that are valid are not documented.
    ///////////////////////////////////////////////////////////////////////////////
    private ed_instructions = [];

    private initializeEdInstructions() {
        // 0x40 : IN B, (C)
        this.ed_instructions[0x40] = () => {
            this.b = this.do_in((this.b << 8) | this.c);
        };
        // 0x41 : OUT (C), B
        this.ed_instructions[0x41] = () => {
            this.core.io_write((this.b << 8) | this.c, this.b);
        };
        // 0x42 : SBC HL, BC
        this.ed_instructions[0x42] = () => {
            this.do_hl_sbc(this.c | (this.b << 8));
        };
        // 0x43 : LD (nn), BC
        this.ed_instructions[0x43] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.c);
            this.core.mem_write((address + 1) & 0xffff, this.b);
        };
        // 0x44 : NEG
        this.ed_instructions[0x44] = () => {
            this.do_neg();
        };
        // 0x45 : RETN
        this.ed_instructions[0x45] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x46 : IM 0
        this.ed_instructions[0x46] = () => {
            this.imode = 0;
        };
        // 0x47 : LD I, A
        this.ed_instructions[0x47] = () => {
            this.i = this.a
        };
        // 0x48 : IN C, (C)
        this.ed_instructions[0x48] = () => {
            this.c = this.do_in((this.b << 8) | this.c);
        };
        // 0x49 : OUT (C), C
        this.ed_instructions[0x49] = () => {
            this.core.io_write((this.b << 8) | this.c, this.c);
        };
        // 0x4a : ADC HL, BC
        this.ed_instructions[0x4a] = () => {
            this.do_hl_adc(this.c | (this.b << 8));
        };
        // 0x4b : LD BC, (nn)
        this.ed_instructions[0x4b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.c = this.core.mem_read(address);
            this.b = this.core.mem_read((address + 1) & 0xffff);
        };
        // 0x4c : NEG (Undocumented)
        this.ed_instructions[0x4c] = () => {
            this.do_neg();
        };
        // 0x4d : RETI
        this.ed_instructions[0x4d] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
        };
        // 0x4e : IM 0 (Undocumented)
        this.ed_instructions[0x4e] = () => {
            this.imode = 0;
        };
        // 0x4f : LD R, A
        this.ed_instructions[0x4f] = () => {
            this.r = this.a;
        };
        // 0x50 : IN D, (C)
        this.ed_instructions[0x50] = () => {
            this.d = this.do_in((this.b << 8) | this.c);
        };
        // 0x51 : OUT (C), D
        this.ed_instructions[0x51] = () => {
            this.core.io_write((this.b << 8) | this.c, this.d);
        };
        // 0x52 : SBC HL, DE
        this.ed_instructions[0x52] = () => {
            this.do_hl_sbc(this.e | (this.d << 8));
        };
        // 0x53 : LD (nn), DE
        this.ed_instructions[0x53] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.e);
            this.core.mem_write((address + 1) & 0xffff, this.d);
        };
        // 0x54 : NEG (Undocumented)
        this.ed_instructions[0x54] = () => {
            this.do_neg();
        };
        // 0x55 : RETN
        this.ed_instructions[0x55] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x56 : IM 1
        this.ed_instructions[0x56] = () => {
            this.imode = 1;
        };
        // 0x57 : LD A, I
        this.ed_instructions[0x57] = () => {
            this.a = this.i;
            this.flags.P = this.iff2;
        };
        // 0x58 : IN E, (C)
        this.ed_instructions[0x58] = () => {
            this.e = this.do_in((this.b << 8) | this.c);
        };
        // 0x59 : OUT (C), E
        this.ed_instructions[0x59] = () => {
            this.core.io_write((this.b << 8) | this.c, this.e);
        };
        // 0x5a : ADC HL, DE
        this.ed_instructions[0x5a] = () => {
            this.do_hl_adc(this.e | (this.d << 8));
        };
        // 0x5b : LD DE, (nn)
        this.ed_instructions[0x5b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.e = this.core.mem_read(address);
            this.d = this.core.mem_read((address + 1) & 0xffff);
        };
        // 0x5c : NEG (Undocumented)
        this.ed_instructions[0x5c] = () => {
            this.do_neg();
        };
        // 0x5d : RETN
        this.ed_instructions[0x5d] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x5e : IM 2
        this.ed_instructions[0x5e] = () => {
            this.imode = 2;
        };
        // 0x5f : LD A, R
        this.ed_instructions[0x5f] = () => {
            this.a = this.r;
            this.flags.P = this.iff2;
        };
        // 0x60 : IN H, (C)
        this.ed_instructions[0x60] = () => {
            this.h = this.do_in((this.b << 8) | this.c);
        };
        // 0x61 : OUT (C), H
        this.ed_instructions[0x61] = () => {
            this.core.io_write((this.b << 8) | this.c, this.h);
        };
        // 0x62 : SBC HL, HL
        this.ed_instructions[0x62] = () => {
            this.do_hl_sbc(this.l | (this.h << 8));
        };
        // 0x63 : LD (nn), HL (Undocumented)
        this.ed_instructions[0x63] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.l);
            this.core.mem_write((address + 1) & 0xffff, this.h);
        };
        // 0x64 : NEG (Undocumented)
        this.ed_instructions[0x64] = () => {
            this.do_neg();
        };
        // 0x65 : RETN
        this.ed_instructions[0x65] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x66 : IM 0
        this.ed_instructions[0x66] = () => {
            this.imode = 0;
        };
        // 0x67 : RRD
        this.ed_instructions[0x67] = () => {
            var hl_value = this.core.mem_read(this.l | (this.h << 8));
            var temp1 = hl_value & 0x0f, temp2 = this.a & 0x0f;
            hl_value = ((hl_value & 0xf0) >>> 4) | (temp2 << 4);
            this.a = (this.a & 0xf0) | temp1;
            this.core.mem_write(this.l | (this.h << 8), hl_value);

            this.flags.S = (this.a & 0x80) ? 1 : 0;
            this.flags.Z = this.a ? 0 : 1;
            this.flags.H = 0;
            this.flags.P = this.get_parity(this.a) ? 1 : 0;
            this.flags.N = 0;
            this.update_xy_flags(this.a);
        };
        // 0x68 : IN L, (C)
        this.ed_instructions[0x68] = () => {
            this.l = this.do_in((this.b << 8) | this.c);
        };
        // 0x69 : OUT (C), L
        this.ed_instructions[0x69] = () => {
            this.core.io_write((this.b << 8) | this.c, this.l);
        };
        // 0x6a : ADC HL, HL
        this.ed_instructions[0x6a] = () => {
            this.do_hl_adc(this.l | (this.h << 8));
        };
        // 0x6b : LD HL, (nn) (Undocumented)
        this.ed_instructions[0x6b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.l = this.core.mem_read(address);
            this.h = this.core.mem_read((address + 1) & 0xffff);
        };
        // 0x6c : NEG (Undocumented)
        this.ed_instructions[0x6c] = () => {
            this.do_neg();
        };
        // 0x6d : RETN
        this.ed_instructions[0x6d] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x6e : IM 0 (Undocumented)
        this.ed_instructions[0x6e] = () => {
            this.imode = 0;
        };
        // 0x6f : RLD
        this.ed_instructions[0x6f] = () => {
            var hl_value = this.core.mem_read(this.l | (this.h << 8));
            var temp1 = hl_value & 0xf0, temp2 = this.a & 0x0f;
            hl_value = ((hl_value & 0x0f) << 4) | temp2;
            this.a = (this.a & 0xf0) | (temp1 >>> 4);
            this.core.mem_write(this.l | (this.h << 8), hl_value);

            this.flags.S = (this.a & 0x80) ? 1 : 0;
            this.flags.Z = this.a ? 0 : 1;
            this.flags.H = 0;
            this.flags.P = this.get_parity(this.a) ? 1 : 0;
            this.flags.N = 0;
            this.update_xy_flags(this.a);
        };
        // 0x70 : IN (C) (Undocumented)
        this.ed_instructions[0x70] = () => {
            this.do_in((this.b << 8) | this.c);
        };
        // 0x71 : OUT (C), 0 (Undocumented)
        this.ed_instructions[0x71] = () => {
            this.core.io_write((this.b << 8) | this.c, 0);
        };
        // 0x72 : SBC HL, SP
        this.ed_instructions[0x72] = () => {
            this.do_hl_sbc(this.sp);
        };
        // 0x73 : LD (nn), SP
        this.ed_instructions[0x73] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.core.mem_write(address, this.sp & 0xff);
            this.core.mem_write((address + 1) & 0xffff, (this.sp >>> 8) & 0xff);
        };
        // 0x74 : NEG (Undocumented)
        this.ed_instructions[0x74] = () => {
            this.do_neg();
        };
        // 0x75 : RETN
        this.ed_instructions[0x75] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x76 : IM 1
        this.ed_instructions[0x76] = () => {
            this.imode = 1;
        };
        // 0x78 : IN A, (C)
        this.ed_instructions[0x78] = () => {
            this.a = this.do_in((this.b << 8) | this.c);
        };
        // 0x79 : OUT (C), A
        this.ed_instructions[0x79] = () => {
            this.core.io_write((this.b << 8) | this.c, this.a);
        };
        // 0x7a : ADC HL, SP
        this.ed_instructions[0x7a] = () => {
            this.do_hl_adc(this.sp);
        };
        // 0x7b : LD SP, (nn)
        this.ed_instructions[0x7b] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= this.core.mem_read(this.pc) << 8;

            this.sp = this.core.mem_read(address);
            this.sp |= this.core.mem_read((address + 1) & 0xffff) << 8;
        };
        // 0x7c : NEG (Undocumented)
        this.ed_instructions[0x7c] = () => {
            this.do_neg();
        };
        // 0x7d : RETN
        this.ed_instructions[0x7d] = () => {
            this.pc = (this.pop_word() - 1) & 0xffff;
            this.iff1 = this.iff2;
        };
        // 0x7e : IM 2
        this.ed_instructions[0x7e] = () => {
            this.imode = 2;
        };
        // 0xa0 : LDI
        this.ed_instructions[0xa0] = () => {
            this.do_ldi();
        };
        // 0xa1 : CPI
        this.ed_instructions[0xa1] = () => {
            this.do_cpi();
        };
        // 0xa2 : INI
        this.ed_instructions[0xa2] = () => {
            this.do_ini();
        };
        // 0xa3 : OUTI
        this.ed_instructions[0xa3] = () => {
            this.do_outi();
        };
        // 0xa8 : LDD
        this.ed_instructions[0xa8] = () => {
            this.do_ldd();
        };
        // 0xa9 : CPD
        this.ed_instructions[0xa9] = () => {
            this.do_cpd();
        };
        // 0xaa : IND
        this.ed_instructions[0xaa] = () => {
            this.do_ind();
        };
        // 0xab : OUTD
        this.ed_instructions[0xab] = () => {
            this.do_outd();
        };
        // 0xb0 : LDIR
        this.ed_instructions[0xb0] = () => {
            this.do_ldi();
            if (this.b || this.c) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb1 : CPIR
        this.ed_instructions[0xb1] = () => {
            this.do_cpi();
            if (!this.flags.Z && (this.b || this.c)) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb2 : INIR
        this.ed_instructions[0xb2] = () => {
            this.do_ini();
            if (this.b) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb3 : OTIR
        this.ed_instructions[0xb3] = () => {
            this.do_outi();
            if (this.b) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb8 : LDDR
        this.ed_instructions[0xb8] = () => {
            this.do_ldd();
            if (this.b || this.c) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xb9 : CPDR
        this.ed_instructions[0xb9] = () => {
            this.do_cpd();
            if (!this.flags.Z && (this.b || this.c)) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xba : INDR
        this.ed_instructions[0xba] = () => {
            this.do_ind();
            if (this.b) {
                this.cycle_counter += 5;
                this.pc = (this.pc - 2) & 0xffff;
            }
        };
        // 0xbb : OTDR
        this.ed_instructions[0xbb] = () => {
            this.do_outd();
            if (this.b) {
                this.cycle_counter += 5;
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
    private dd_instructions = [];

    private initializeDdInstructions() {
        // 0x09 : ADD IX, BC
        this.dd_instructions[0x09] = () => {
            this.do_ix_add(this.c | (this.b << 8));
        };
        // 0x19 : ADD IX, DE
        this.dd_instructions[0x19] = () => {
            this.do_ix_add(this.e | (this.d << 8));
        };
        // 0x21 : LD IX, nn
        this.dd_instructions[0x21] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            this.ix |= (this.core.mem_read(this.pc) << 8);
        };
        // 0x22 : LD (nn), IX
        this.dd_instructions[0x22] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= (this.core.mem_read(this.pc) << 8);

            this.core.mem_write(address, this.ix & 0xff);
            this.core.mem_write((address + 1) & 0xffff, (this.ix >>> 8) & 0xff);
        };
        // 0x23 : INC IX
        this.dd_instructions[0x23] = () => {
            this.ix = (this.ix + 1) & 0xffff;
        };
        // 0x24 : INC IXH (Undocumented)
        this.dd_instructions[0x24] = () => {
            this.ix = (this.do_inc(this.ix >>> 8) << 8) | (this.ix & 0xff);
        };
        // 0x25 : DEC IXH (Undocumented)
        this.dd_instructions[0x25] = () => {
            this.ix = (this.do_dec(this.ix >>> 8) << 8) | (this.ix & 0xff);
        };
        // 0x26 : LD IXH, n (Undocumented)
        this.dd_instructions[0x26] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = (this.core.mem_read(this.pc) << 8) | (this.ix & 0xff);
        };
        // 0x29 : ADD IX, IX
        this.dd_instructions[0x29] = () => {
            this.do_ix_add(this.ix);
        };
        // 0x2a : LD IX, (nn)
        this.dd_instructions[0x2a] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var address = this.core.mem_read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            address |= (this.core.mem_read(this.pc) << 8);

            this.ix = this.core.mem_read(address);
            this.ix |= (this.core.mem_read((address + 1) & 0xffff) << 8);
        };
        // 0x2b : DEC IX
        this.dd_instructions[0x2b] = () => {
            this.ix = (this.ix - 1) & 0xffff;
        };
        // 0x2c : INC IXL (Undocumented)
        this.dd_instructions[0x2c] = () => {
            this.ix = this.do_inc(this.ix & 0xff) | (this.ix & 0xff00);
        };
        // 0x2d : DEC IXL (Undocumented)
        this.dd_instructions[0x2d] = () => {
            this.ix = this.do_dec(this.ix & 0xff) | (this.ix & 0xff00);
        };
        // 0x2e : LD IXL, n (Undocumented)
        this.dd_instructions[0x2e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            this.ix = (this.core.mem_read(this.pc) & 0xff) | (this.ix & 0xff00);
        };
        // 0x34 : INC (IX+n)
        this.dd_instructions[0x34] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc)),
                value = this.core.mem_read((offset + this.ix) & 0xffff);
            this.core.mem_write((offset + this.ix) & 0xffff, this.do_inc(value));
        };
        // 0x35 : DEC (IX+n)
        this.dd_instructions[0x35] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc)),
                value = this.core.mem_read((offset + this.ix) & 0xffff);
            this.core.mem_write((offset + this.ix) & 0xffff, this.do_dec(value));
        };
        // 0x36 : LD (IX+n), n
        this.dd_instructions[0x36] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.pc = (this.pc + 1) & 0xffff;
            this.core.mem_write((this.ix + offset) & 0xffff, this.core.mem_read(this.pc));
        };
        // 0x39 : ADD IX, SP
        this.dd_instructions[0x39] = () => {
            this.do_ix_add(this.sp);
        };
        // 0x44 : LD B, IXH (Undocumented)
        this.dd_instructions[0x44] = () => {
            this.b = (this.ix >>> 8) & 0xff;
        };
        // 0x45 : LD B, IXL (Undocumented)
        this.dd_instructions[0x45] = () => {
            this.b = this.ix & 0xff;
        };
        // 0x46 : LD B, (IX+n)
        this.dd_instructions[0x46] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.b = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x4c : LD C, IXH (Undocumented)
        this.dd_instructions[0x4c] = () => {
            this.c = (this.ix >>> 8) & 0xff;
        };
        // 0x4d : LD C, IXL (Undocumented)
        this.dd_instructions[0x4d] = () => {
            this.c = this.ix & 0xff;
        };
        // 0x4e : LD C, (IX+n)
        this.dd_instructions[0x4e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.c = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x54 : LD D, IXH (Undocumented)
        this.dd_instructions[0x54] = () => {
            this.d = (this.ix >>> 8) & 0xff;
        };
        // 0x55 : LD D, IXL (Undocumented)
        this.dd_instructions[0x55] = () => {
            this.d = this.ix & 0xff;
        };
        // 0x56 : LD D, (IX+n)
        this.dd_instructions[0x56] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.d = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x5c : LD E, IXH (Undocumented)
        this.dd_instructions[0x5c] = () => {
            this.e = (this.ix >>> 8) & 0xff;
        };
        // 0x5d : LD E, IXL (Undocumented)
        this.dd_instructions[0x5d] = () => {
            this.e = this.ix & 0xff;
        };
        // 0x5e : LD E, (IX+n)
        this.dd_instructions[0x5e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.e = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x60 : LD IXH, B (Undocumented)
        this.dd_instructions[0x60] = () => {
            this.ix = (this.ix & 0xff) | (this.b << 8);
        };
        // 0x61 : LD IXH, C (Undocumented)
        this.dd_instructions[0x61] = () => {
            this.ix = (this.ix & 0xff) | (this.c << 8);
        };
        // 0x62 : LD IXH, D (Undocumented)
        this.dd_instructions[0x62] = () => {
            this.ix = (this.ix & 0xff) | (this.d << 8);
        };
        // 0x63 : LD IXH, E (Undocumented)
        this.dd_instructions[0x63] = () => {
            this.ix = (this.ix & 0xff) | (this.e << 8);
        };
        // 0x64 : LD IXH, IXH (Undocumented)
        this.dd_instructions[0x64] = () => {
            // No-op.
        };
        // 0x65 : LD IXH, IXL (Undocumented)
        this.dd_instructions[0x65] = () => {
            this.ix = (this.ix & 0xff) | ((this.ix & 0xff) << 8);
        };
        // 0x66 : LD H, (IX+n)
        this.dd_instructions[0x66] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.h = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x67 : LD IXH, A (Undocumented)
        this.dd_instructions[0x67] = () => {
            this.ix = (this.ix & 0xff) | (this.a << 8);
        };
        // 0x68 : LD IXL, B (Undocumented)
        this.dd_instructions[0x68] = () => {
            this.ix = (this.ix & 0xff00) | this.b;
        };
        // 0x69 : LD IXL, C (Undocumented)
        this.dd_instructions[0x69] = () => {
            this.ix = (this.ix & 0xff00) | this.c;
        };
        // 0x6a : LD IXL, D (Undocumented)
        this.dd_instructions[0x6a] = () => {
            this.ix = (this.ix & 0xff00) | this.d;
        };
        // 0x6b : LD IXL, E (Undocumented)
        this.dd_instructions[0x6b] = () => {
            this.ix = (this.ix & 0xff00) | this.e;
        };
        // 0x6c : LD IXL, IXH (Undocumented)
        this.dd_instructions[0x6c] = () => {
            this.ix = (this.ix & 0xff00) | (this.ix >>> 8);
        };
        // 0x6d : LD IXL, IXL (Undocumented)
        this.dd_instructions[0x6d] = () => {
            // No-op.
        };
        // 0x6e : LD L, (IX+n)
        this.dd_instructions[0x6e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.l = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x6f : LD IXL, A (Undocumented)
        this.dd_instructions[0x6f] = () => {
            this.ix = (this.ix & 0xff00) | this.a;
        };
        // 0x70 : LD (IX+n), B
        this.dd_instructions[0x70] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.b);
        };
        // 0x71 : LD (IX+n), C
        this.dd_instructions[0x71] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.c);
        };
        // 0x72 : LD (IX+n), D
        this.dd_instructions[0x72] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.d);
        };
        // 0x73 : LD (IX+n), E
        this.dd_instructions[0x73] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.e);
        };
        // 0x74 : LD (IX+n), H
        this.dd_instructions[0x74] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.h);
        };
        // 0x75 : LD (IX+n), L
        this.dd_instructions[0x75] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.l);
        };
        // 0x77 : LD (IX+n), A
        this.dd_instructions[0x77] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.core.mem_write((this.ix + offset) & 0xffff, this.a);
        };
        // 0x7c : LD A, IXH (Undocumented)
        this.dd_instructions[0x7c] = () => {
            this.a = (this.ix >>> 8) & 0xff;
        };
        // 0x7d : LD A, IXL (Undocumented)
        this.dd_instructions[0x7d] = () => {
            this.a = this.ix & 0xff;
        };
        // 0x7e : LD A, (IX+n)
        this.dd_instructions[0x7e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.a = this.core.mem_read((this.ix + offset) & 0xffff);
        };
        // 0x84 : ADD A, IXH (Undocumented)
        this.dd_instructions[0x84] = () => {
            this.do_add((this.ix >>> 8) & 0xff);
        };
        // 0x85 : ADD A, IXL (Undocumented)
        this.dd_instructions[0x85] = () => {
            this.do_add(this.ix & 0xff);
        };
        // 0x86 : ADD A, (IX+n)
        this.dd_instructions[0x86] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_add(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0x8c : ADC A, IXH (Undocumented)
        this.dd_instructions[0x8c] = () => {
            this.do_adc((this.ix >>> 8) & 0xff);
        };
        // 0x8d : ADC A, IXL (Undocumented)
        this.dd_instructions[0x8d] = () => {
            this.do_adc(this.ix & 0xff);
        };
        // 0x8e : ADC A, (IX+n)
        this.dd_instructions[0x8e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_adc(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0x94 : SUB IXH (Undocumented)
        this.dd_instructions[0x94] = () => {
            this.do_sub((this.ix >>> 8) & 0xff);
        };
        // 0x95 : SUB IXL (Undocumented)
        this.dd_instructions[0x95] = () => {
            this.do_sub(this.ix & 0xff);
        };
        // 0x96 : SUB A, (IX+n)
        this.dd_instructions[0x96] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_sub(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0x9c : SBC IXH (Undocumented)
        this.dd_instructions[0x9c] = () => {
            this.do_sbc((this.ix >>> 8) & 0xff);
        };
        // 0x9d : SBC IXL (Undocumented)
        this.dd_instructions[0x9d] = () => {
            this.do_sbc(this.ix & 0xff);
        };
        // 0x9e : SBC A, (IX+n)
        this.dd_instructions[0x9e] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_sbc(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0xa4 : AND IXH (Undocumented)
        this.dd_instructions[0xa4] = () => {
            this.do_and((this.ix >>> 8) & 0xff);
        };
        // 0xa5 : AND IXL (Undocumented)
        this.dd_instructions[0xa5] = () => {
            this.do_and(this.ix & 0xff);
        };
        // 0xa6 : AND A, (IX+n)
        this.dd_instructions[0xa6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_and(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0xac : XOR IXH (Undocumented)
        this.dd_instructions[0xac] = () => {
            this.do_xor((this.ix >>> 8) & 0xff);
        };
        // 0xad : XOR IXL (Undocumented)
        this.dd_instructions[0xad] = () => {
            this.do_xor(this.ix & 0xff);
        };
        // 0xae : XOR A, (IX+n)
        this.dd_instructions[0xae] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_xor(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0xb4 : OR IXH (Undocumented)
        this.dd_instructions[0xb4] = () => {
            this.do_or((this.ix >>> 8) & 0xff);
        };
        // 0xb5 : OR IXL (Undocumented)
        this.dd_instructions[0xb5] = () => {
            this.do_or(this.ix & 0xff);
        };
        // 0xb6 : OR A, (IX+n)
        this.dd_instructions[0xb6] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_or(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0xbc : CP IXH (Undocumented)
        this.dd_instructions[0xbc] = () => {
            this.do_cp((this.ix >>> 8) & 0xff);
        };
        // 0xbd : CP IXL (Undocumented)
        this.dd_instructions[0xbd] = () => {
            this.do_cp(this.ix & 0xff);
        };
        // 0xbe : CP A, (IX+n)
        this.dd_instructions[0xbe] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.do_cp(this.core.mem_read((this.ix + offset) & 0xffff));
        };
        // 0xcb : CB Prefix (IX bit instructions)
        this.dd_instructions[0xcb] = () => {
            this.pc = (this.pc + 1) & 0xffff;
            var offset = this.get_signed_offset_byte(this.core.mem_read(this.pc));
            this.pc = (this.pc + 1) & 0xffff;
            var opcode = this.core.mem_read(this.pc), value;

            // As with the "normal" CB prefix, we implement the DDCB prefix
            //  by decoding the opcode directly, rather than using a table.
            if (opcode < 0x40) {
                // Shift and rotate instructions.
                var ddcb_functions = [this.do_rlc, this.do_rrc, this.do_rl, this.do_rr,
                this.do_sla, this.do_sra, this.do_sll, this.do_srl];

                // Most of the opcodes in this range are not valid,
                //  so we map this opcode onto one of the ones that is.
                var func = ddcb_functions[(opcode & 0x38) >>> 3],
                    value = func.call(this, this.core.mem_read((this.ix + offset) & 0xffff));

                this.core.mem_write((this.ix + offset) & 0xffff, value);
            }
            else {
                var bit_number = (opcode & 0x38) >>> 3;

                if (opcode < 0x80) {
                    // BIT
                    this.flags.N = 0;
                    this.flags.H = 1;
                    this.flags.Z = !(this.core.mem_read((this.ix + offset) & 0xffff) & (1 << bit_number)) ? 1 : 0;
                    this.flags.P = this.flags.Z;
                    this.flags.S = ((bit_number === 7) && !this.flags.Z) ? 1 : 0;
                }
                else if (opcode < 0xc0) {
                    // RES
                    value = this.core.mem_read((this.ix + offset) & 0xffff) & ~(1 << bit_number) & 0xff;
                    this.core.mem_write((this.ix + offset) & 0xffff, value);
                }
                else {
                    // SET
                    value = this.core.mem_read((this.ix + offset) & 0xffff) | (1 << bit_number);
                    this.core.mem_write((this.ix + offset) & 0xffff, value);
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

            this.cycle_counter += this.cycle_counts_cb[opcode] + 8;
        };
        // 0xe1 : POP IX
        this.dd_instructions[0xe1] = () => {
            this.ix = this.pop_word();
        };
        // 0xe3 : EX (SP), IX
        this.dd_instructions[0xe3] = () => {
            var temp = this.ix;
            this.ix = this.core.mem_read(this.sp);
            this.ix |= this.core.mem_read((this.sp + 1) & 0xffff) << 8;
            this.core.mem_write(this.sp, temp & 0xff);
            this.core.mem_write((this.sp + 1) & 0xffff, (temp >>> 8) & 0xff);
        };
        // 0xe5 : PUSH IX
        this.dd_instructions[0xe5] = () => {
            this.push_word(this.ix);
        };
        // 0xe9 : JP (IX)
        this.dd_instructions[0xe9] = () => {
            this.pc = (this.ix - 1) & 0xffff;
        };
        // 0xf9 : LD SP, IX
        this.dd_instructions[0xf9] = () => {
            this.sp = this.ix;
        };
    }

    ///////////////////////////////////////////////////////////////////////////////
    /// These tables contain the number of T cycles used for each instruction.
    /// In a few special cases, such as conditional control flow instructions,
    ///  additional cycles might be added to these values.
    /// The total number of cycles is the return value of run_instruction().
    ///////////////////////////////////////////////////////////////////////////////
    private cycle_counts = [
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

    private cycle_counts_ed = [
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

    private cycle_counts_cb = [
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

    private cycle_counts_dd = [
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
}