# Precise natural harmonic targets

The optional chart field `hps` accompanies `hm:true` and retains the source's
integer semitone approximation of a natural harmonic. `f` stays unchanged for
note identity. Expected pitch includes tuning and capo; known partials 2–8
use their actual frequency ratios rather than equal-tempered approximations.
This avoids rejecting a correctly played seventh partial at normal strict
pitch thresholds. No pitch window is widened for this feature.

The browser FFT check and Desktop bridge target the sounding harmonic.
Explicit targets do not use legacy `hm` energy-only acceptance. A lone target
rejects stronger octave/subharmonic fundamentals; polyphonic ambiguity remains
subject to the existing chord-scoring policy. Source preservation and on-screen
touch placement are handled by the matching FeedForge and core branches.

Requires Desktop `feat/precise-natural-harmonics` for native scoring. Deploy
the matching components together; an older addon ignores the new field.

Run `node --test tests/natural-harmonics.test.cjs`. The synthetic tests check
correct partials, wrong notes, silence, tuning and capo. Live DI validation
on guitar/bass is still necessary before calling recognition production-proven.
