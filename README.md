# CIdoru v. 1.9.0


## DISCLAIMER:
CIdoru is a custom, alternative companion application for the multi-track player IDORU P-1,
originally developed by the Berlin-based Idoru Live UG team around Adam Ferns. Adam is aware
of the existence of this alternative application, but by no means are he and his team even
remotely responsible for any issues or bugs related to using this software, nor are they
obliged to provide any support related to it. This is third-party software, unrelated to
anything the Idoru Live UG team does. Whenever you have any issues or requests, please
contact the party involved with this particular application (see the Contact chapter).


## WHAT IS CIDORU AND WHY DOES IT EVEN EXIST?
In short, CIdoru does what the original Idoru software does. So why does it exist? OK, you
asked for this...

Long story short, I believe I was one of the earlier owners of the Idoru P-1. A couple of
years ago I started a fresh music project heavily based on backing tracks. Having had bad
experiences using a computer for backing tracks live, I was struggling to find a suitable
multi-track player. Cymatic had just gone out of business (and they never delivered on their
promises, to be honest), and Joe & Co. were asking an insane amount of money for their
products (which were never intended for small-band use cases, to be fair to them). And that
was it. It was also around that time that I stumbled upon Idoru. I ordered it, explored it,
started using it, and instantly fell in love with it. Famous German engineering at its finest.
Period.

While the hardware was perfect, the same couldn't be said about the companion app. It had
plenty of classic teething issues — nothing super problematic that would render the hardware
useless, but annoying, especially when you have to use it a lot. Which I did. I also lacked
some features that would have made my workflow more straightforward. I discussed these with
Adam, but being a software developer myself for decades, I knew there was a huge pile of work
ahead of Adam's team and that my requests were not at the top of their list. Nothing to blame
them for. And because the Idoru file structure is described in the manual, I decided to
address those issues by myself, on my own.

The funny thing is that even with all the resolve I had when starting this project, it took
me quite some time to finish it — and in the meantime, the original app solved almost all the
issues I had with it. Oh well, that happens. But since I put a lot of effort into this
alternative application, I'd be quite bitter just to dump it. So here we are. You can choose
— it is absolutely up to you. If you prefer the original companion app, or you'd like to stay
with the version supported by the original team, stick with that. If you like my version with
a slightly different workflow and, honestly, probably slower support, be my guest — I'll be
flattered. But please, do not bother Adam and his team with any issues that may come up while
using my version. Those are on me, not Adam's. Thank you kindly for your understanding.


## TWO VERSIONS: WEB AND DESKTOP
CIdoru comes in two flavours.

The web version runs entirely in your browser — no installation required. It is intended for
quick demos and emergency situations, for example when you need to make a last-minute change
to a playlist five minutes before a gig and your laptop is not with you. Open a browser,
navigate to the CIdoru URL, and you're in. It has limitations though — see below.

The desktop version is a proper installable application for Windows and Linux, built with
Electron. It is the recommended choice for regular use. It remembers file paths between
sessions, can verify files on disk, handles SD card transfers without browser restrictions,
and can download and install firmware automatically. See INSTALL.md for installation
instructions.


## WHAT IS THE DIFFERENCE BETWEEN THE ORIGINAL APP AND THIS ONE?
Aside from the visual look and the technology under the hood? Not much. But there are some
differences. Let's start with a slightly different workflow:

- Everything is present on one screen — the playlists, the songs, everything. Creating a
  playlist, creating a song, editing a song, changing order — you name it, everything is
  within reach without the need to switch screens.
- You can select audio files, the channel code, and force mono/stereo channel mode directly
  in the "New Song" window. Or you can set it later, like the original app does. Up to you.
- When setting values, everything except one is fader-based rather than knob-based. I like
  knobs on actual hardware, but software knobs are a pain in the backside — my two cents.
- If faders are too time-consuming, switch to matrix view and set values directly in a table,
  navigating with TAB and entering numeric values. You're welcome.
- The desktop version can check for the latest firmware, download it, and write it to your
  SD card automatically. The web version provides manual instructions instead.
- Audio preview in real time. You can check how all outputs sound like in stereo and modify
  their respective levels accordingly
- it reads original Idoru file format. No need to re-create your projects from the scratch.
- Live update implemented. Whenever new version appears on GitHub, it's downloaded automatically.
- CIdoru doesn't have global settings, but introduces presets. A preset is a stored mixer
  state that you can save at any point and apply to another song or session.
- When creating a new song, you can directly specify which playlist(s) it will belong to.
- CIdoru shows a dynamic routing map below the mixer, giving you a clear overview of what
  is going to which output and at what level.
- Each audio file strip shows a file occupancy indicator — a green dot when a file is
  assigned, dim when the slot is empty. Hover for the full filename.
- Strips can be individually reset — clearing the file, routing, fader and mute in one click.
- Light and dark theme, switchable at any time from the toolbar.


## ARE THERE ANY LIMITATIONS OR CONS?
I'm glad you asked. Of course there are.

- While the original Idoru software can communicate directly with the hardware via USB,
  CIdoru cannot. SD card transfer is the only supported method. Eject the SD card from
  the device, put it in your card reader, and use CIdoru's Transfer function.

- Desktop version: file paths are remembered between sessions. As long as you don't move
  your audio files, you only need to pick them once. If you do move them, use Scan & Relink.

- Web version: audio and MIDI files must be re-picked every session before transferring.
  File paths are not stored between page loads. Scan cannot verify files on disk.
  Firmware auto-download is not available.

- Web version session data lives in browser local storage. Regular JSON exports are
  strongly recommended to avoid losing your work.

- CIdoru will always be one step behind the original app. Adam is under no obligation to
  inform me about structural changes, so at some point CIdoru may stop working correctly.
  Any such changes will be addressed reactively — I'll contact Adam, ask nicely, and hope
  for the best.

- Support. I'm not doing this for a living. While I feel obliged to address any issues my
  software may cause, I do it in my spare time, and my spare time is scarce. You have been
  informed.


## SO HOW DOES IT WORK?
Pretty much the same as the original Idoru app. All restrictions — file format
(44.1 kHz / 16-bit), naming conventions, character limits (32 characters max) and so on —
are validated and enforced in CIdoru as well. Your best starting point is the original manual:
https://support.idoru.live/introduction-to-the-idoru-p-1-software

The CIdoru user manual is available via the MANUAL button in the toolbar, and as MANUAL.html
in the application folder.


## WHO ARE YOU AND HOW CAN I CONTACT YOU?
My name is Barney Estrada, I'm a semi-professional musician and a professional software developer with more than 30 years
of experience in both fields, living in the Czech Republic. I'd prefer you leave me alone,
but if you must, send me an email at barney.estrada@bastardizer.cz.
