// A lived-in account for the synthetic dataset: five weeks of one student's conversations with the
// people in their life. Sofía is a computer science junior in Austin; the cast is her grandmother and
// mother (Spanish and English), two friends, a roommate, and two people she met through recruiting.
//
// Each entry is what a real recording would have left behind, written by hand:
// - lines: the diarized transcript. [speaker, text, opts]; opts.gap / opts.overlap move the start
//   (ms after / before the previous line ended), opts.crowd marks a bystander the lip lock filtered out.
// - classify, coach, followUp, insight, nextStep: what Muse Spark would have answered. The builder
//   runs them through the real agents, so anything that fails validation falls back like it would live.
// - face: how the other person's face moved, used to synthesize MediaPipe frames for the Replay page.
//   reactions[turnId] is the smile change in the 2.5 s after one of your lines; nods and away are per turn.
// Turn ids count every line, crowd included, the way the transcriber numbers them.

const abuela = {
  tag: 'family',
  otherName: 'Abuela',
};

export const SYNTHETIC_USER = Object.freeze({ name: 'Sofía', about: 'CS junior at UT Austin' });

export const SYNTHETIC_CONVERSATIONS = [
  {
    key: 'abuela-metate',
    ...abuela,
    daysAgo: 33, at: '19:10',
    video: { mime: 'video/mp4', offsetMs: 240 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', 'Hola Abuela! ¿Cómo estás? How was your week?'],
      ['B', "Ay, mija, my knee has been bothering me again. Tengo cita con el doctor el jueves, and your tío has to drive me because I can't do the stairs at the clinic."],
      ['A', 'Oh no. I had my first midterm this week, it was so hard, I studied all weekend and I still ran out of time on the last problem.'],
      ['B', 'Pobrecita. You always work so hard. Are you eating well?'],
      ['A', 'Yes, I promise. What are you cooking this week?'],
      ['B', 'Mole for the church dinner on Sunday. My mother\'s recipe, with the chocolate from Oaxaca that your Tía Lupe sends me.'],
      ['A', 'Wait, Tía Lupe sends you chocolate from Oaxaca?'],
      ['B', 'Every Christmas! She wraps it in newspaper so it doesn\'t break, y siempre pone una notita con la fecha. Your great-grandmother taught us both to grind it by hand on the metate.'],
      ['A', 'On the metate? How long did it take you to grind it?'],
      ['B', 'All morning, mija. We would start before the sun came up and sing so the time would go faster.'],
      ['A', "I'll call you Thursday after the doctor to see how it went."],
      ['B', 'Ay, gracias mija. Te quiero mucho.'],
    ],
    reflection: 'She told me about her knee and I jumped straight to my midterm. Oops.',
    classify: { followUps: [7, 9], stories: [7, 9], reflections: 0 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you heard ${s.storiesAfterQuestions} stories after them, about Tía Lupe's chocolate and the metate.`,
      suggestion: 'When she brings up her knee, ask one question about the appointment before you share your own week.',
      citedTurnIds: [3, 7, 9],
    }),
    followUp: {
      text: "Hola Abuela! I'll call you Thursday after the doctor. And I want to hear more about grinding chocolate on the metate with Tía Lupe.",
      status: 'sent', sentAfterMin: 35,
    },
    face: {
      baseline: 0.14,
      reactions: { 1: 0.06, 3: -0.07, 5: 0.03, 7: 0.22, 9: 0.18, 11: 0.12 },
      away: { 3: 0.5 },
      nods: { 8: 2, 10: 2, 11: 1 },
    },
    insight: {
      moments: {
        7: { title: 'The chocolate question', why: 'Picking up the exact detail she mentioned opened the longest story of the call.' },
        3: { title: 'Her knee, then your midterm', why: 'She opened with the appointment; ask about it before your own news.' },
        9: { title: 'Staying on the metate', why: 'A second question on the same story got you the part about singing before sunrise.' },
      },
      rewrites: [
        { turnId: 3, title: 'Stay with her knee', tryInstead: 'Your knee again? What did the doctor say last time, and is tío taking you Thursday?', because: 'She opened with her knee and the appointment; one question about it shows you heard her before you share your week.' },
      ],
    },
  },

  {
    key: 'jordan-whiteboard',
    tag: 'friend',
    otherName: 'Jordan Lee',
    daysAgo: 30, at: '21:35',
    video: { mime: 'video/mp4', offsetMs: 180 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', 'Hey, how was your day?'],
      ['B', "Kind of nerve-racking honestly. Verdant wants me for a final round interview next Friday, and I'm already nervous about the system design part."],
      ['A', "No way, that's huge! Which team is it for?"],
      ['B', "The grid forecasting team. They build models that predict how much solar the Texas grid will get each day. It's exactly what I want to work on."],
      ['A', "That's so you. Is the system design part on a whiteboard or on a laptop?"],
      ['B', 'Whiteboard, in person. I always freeze when someone watches me draw boxes, my mind just goes blank.'],
      ['A', "Ugh, I have an algorithms exam on Thursday and I haven't even started the problem set."],
      ['B', "Oh, that's rough. Good luck."],
      ['A', "Thanks. Wait, going back, what if we practiced the whiteboard part together? I'll send you the mock questions from my club tonight."],
      ['B', "Yes, please. Saturday morning? I'll bring the coffee and a marker that actually works."],
      ['A', 'Deal. Saturday at ten, living room whiteboard.'],
    ],
    reflection: 'Good save at the end, but I made the whiteboard thing about my exam for a second.',
    classify: { followUps: [3, 5, 9], stories: [3], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups. When Jordan said their mind goes blank at the whiteboard, your next line was about your exam.`,
      suggestion: 'On Saturday, ask Jordan what usually happens right before the blank moment, before you start the practice questions.',
      citedTurnIds: [6, 7, 9],
    }),
    followUp: {
      text: 'Sent you the mock questions from my club! Saturday at ten for whiteboard practice before the Verdant interview next Friday. You have this.',
      status: 'sent', sentAfterMin: 50,
    },
    face: {
      baseline: 0.17,
      reactions: { 1: 0.02, 3: 0.15, 5: 0.12, 7: -0.08, 9: 0.25 },
      away: { 7: 0.45 },
      nods: { 4: 1, 6: 1, 10: 2 },
    },
    insight: {
      moments: {
        9: { title: 'Coming back to it', why: 'Going back to the whiteboard, and offering to practice, turned a missed moment into a plan.' },
        7: { title: 'The exam detour', why: 'They had just named the scary part; your exam could have waited one question.' },
        3: { title: 'Which team', why: 'A plain question about the job got you the grid forecasting details.' },
      },
      rewrites: [
        { turnId: 7, title: 'Stay with the whiteboard', tryInstead: 'Your mind goes blank at the whiteboard? What does that feel like right when it starts?', because: 'Jordan had just told you the part of Friday that worries them; asking about it first would have kept them talking.' },
      ],
    },
  },

  {
    key: 'daniel-career-fair',
    tag: 'networking',
    otherName: 'Daniel Okafor',
    daysAgo: 27, at: '14:20',
    video: { mime: 'video/mp4', offsetMs: 310 },
    lipLock: true,
    // Daniel spoke first, so the diarizer called him A
    userLabel: 'B',
    lines: [
      ['A', "Hi, I'm Daniel from Halcyon Robotics. Are you a student here?"],
      ['B', "Hi! Yes, I'm a junior in computer science. I'm Sofía."],
      ['C', 'Next group for the Halcyon tour, line up over here please.', { crowd: true, gap: 150 }],
      ['A', 'Nice to meet you. What kind of work are you looking for?'],
      ['B', "Honestly, I've been doing a lot of machine learning, I built a model for my research lab that predicts crop yields from satellite images, and I did a hackathon project with drones, and I'm really interested in robotics, and I want a summer internship."],
      ['A', 'That\'s a great mix. Our team works on the warehouse robots, the arms that pick boxes off shelves. The hard part is when a box is crushed or the label is upside down, the arm has to figure it out live.'],
      ['B', "That's cool. Is the internship application open yet?"],
      ['A', 'The internship application opens next week. We have a hiring info session on Tuesday too, I can put your name on the list.'],
      ['B', 'Yes, please, put me on the list for the info session! Wait, going back to the crushed boxes, how does the arm know a box is crushed?'],
      ['A', 'Depth cameras, plus a model that compares the box to what it should look like. Half my job is collecting weird failure cases, like a box of cat litter that tore open on the line last month.'],
      ['B', "A box of cat litter, that's amazing. Is that the kind of problem an intern would work on?"],
      ['A', 'Last summer our intern built the tool that labels those failure cases. So yes, exactly that kind of thing.'],
      ['B', "I'll email you my resume tonight with the satellite project on top, it has its own pile of failure cases."],
      ['A', "Perfect. Here's my card, it has my email on the back."],
    ],
    reflection: 'I talked way too long about myself at the start. The crushed boxes question was the best part.',
    classify: { followUps: [9, 11], stories: [9, 11], reflections: 0 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and Daniel told the cat litter story after one of them. Your first answer about yourself ran long before you asked about his team.`,
      suggestion: 'Next time, ask what their team is working on before you list your projects.',
      citedTurnIds: [5, 9, 11],
    }),
    followUp: {
      text: 'Hi Daniel, great meeting you at the Halcyon booth today. My resume is attached with the satellite project on top. Still thinking about the crushed boxes and the cat litter!',
      editedText: "Hi Daniel, great meeting you at the Halcyon booth today! Resume attached, satellite project on top. I'd love a spot at the info session on Tuesday, and I'm still thinking about the crushed boxes and the cat litter.",
      status: 'sent', sentAfterMin: 300,
    },
    face: {
      baseline: 0.18,
      reactions: { 2: 0.06, 5: -0.05, 7: -0.06, 9: 0.2, 11: 0.12, 13: 0.1 },
      away: { 5: 0.55, 7: 0.5 },
      nods: { 6: 1, 10: 2, 12: 1 },
    },
    insight: {
      moments: {
        9: { title: 'Back to the crushed boxes', why: 'Going back to the detail he gave you got the most specific answer of the chat.' },
        5: { title: 'The long intro', why: 'A two-sentence answer and a question back would have handed him the floor sooner.' },
        11: { title: 'Intern-sized problem', why: 'Tying his story to the internship made your ask concrete without pitching.' },
      },
      rewrites: [
        { turnId: 7, title: 'Ask about the boxes first', tryInstead: 'Wait, what happens when the label is upside down? How does the arm handle that?', because: 'He had just told you the hard part of his job; one question about it would have come before the internship ask.' },
        { turnId: 5, title: 'Shorter answer, then ask', tryInstead: 'Mostly machine learning, some robotics. What kind of work does your team do?', because: 'A short answer and a question back keeps the first minute about the person you just met.' },
      ],
    },
  },

  {
    key: 'abuela-seeds',
    ...abuela,
    daysAgo: 24, at: '18:05',
    video: null,
    lipLock: false,
    userLabel: 'A',
    lines: [
      ['A', 'Hi Abuela! How did it go at the doctor on Thursday?'],
      ['B', "Better than I thought. The doctor says it's arthritis, nothing to operate. I have to do exercises, ay, like a teenager at the gym."],
      ['A', 'Exercises like what? Show me one next time we video call.'],
      ['B', 'Lifting my leg while I watch my novelas. Twenty times each side. Your tío counts for me and he counts wrong on purpose so I finish early.'],
      ['A', 'Tío counts wrong on purpose? That is so sweet.'],
      ['B', 'He is a good boy. And the tomatoes are coming in, the big ones from Lupe\'s seeds.'],
      ['A', "Lupe's seeds from Oaxaca? How does she keep the seeds good for so long?"],
      ['B', 'She dries them on a plate in the window, then folds them in little paper envelopes with the date. Since we were girls she does it. When I moved here she gave me a jar of seeds wrapped in a dish towel.'],
      ['A', "Wrapped in a dish towel. I want to learn how to do that. I'll call you Sunday and you can teach me."],
      ['B', 'Sí, mija. Bring paper and a pencil.'],
    ],
    reflection: 'Remembered to ask about the doctor first this time.',
    classify: { followUps: [3, 5, 7], stories: [3, 7], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you opened by asking about her doctor visit like you promised. She told you how Tía Lupe saves the seeds.`,
      suggestion: 'On Sunday, ask what else she and Lupe grew in Oaxaca, and write down the Spanish word for each plant.',
      citedTurnIds: [1, 7],
    }),
    followUp: {
      text: "Hola Abuela! I'll call you el domingo so you can teach me Lupe's seed envelopes. Tell tío to count right on your exercises.",
      status: 'sent', sentAfterMin: 20,
    },
    face: null,
    insight: {
      moments: {
        1: { title: 'You kept your promise', obs: 'You opened with the doctor visit you said you would call about.', why: 'Following through on last call is the follow-up she will remember.' },
        3: { title: 'Exercises like what?', obs: 'You asked about the exercises she had just mentioned and heard about the novelas and tío counting wrong.', why: 'A short question about her last word kept her talking.' },
        7: { title: "Lupe's seeds", obs: 'You picked up “Lupe’s seeds” and she answered with the dish towel story, 42 words.', why: 'Naming the person in her story got you the story behind it.' },
      },
      rewrites: [],
    },
  },

  {
    key: 'priya-seattle',
    tag: 'friend',
    otherName: 'Priya Nair',
    daysAgo: 21, at: '12:40',
    video: { mime: 'video/mp4', offsetMs: 200 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', "How's training going? Isn't the half marathon soon?"],
      ['B', "The race is in three weeks! I did fourteen miles on Saturday and my legs are still mad at me. But honestly I'm more stressed about the Seattle offer than the race."],
      ['A', "The Seattle offer? Wait, what's stressing you about it?"],
      ['B', "It's the job I wanted, but it means leaving Austin and my whole running group. I keep making pro and con lists and they come out tied every time."],
      ['C', 'Oat latte for Priya? Oat latte!', { crowd: true, gap: 120 }],
      ['A', "Tied every time, that's so hard. What's on the con side that you can't get past?"],
      ['B', "My mom, mostly. She just started chemo in Houston and Seattle is a four hour flight. I haven't told the recruiter any of this."],
      ['A', "I'm so sorry, Priya. I didn't know about your mom. How is she doing with the chemo?"],
      ['B', 'Tired, but stubborn. She told me to take the job and stop worrying about her, which is very her.'],
      ['A', 'That sounds like her. When do you have to give the recruiter an answer?'],
      ['B', "By November first. I'm going to visit Seattle next weekend to see if I can picture it."],
      ['A', "I'll drive you to the airport for Seattle. Text me your flight."],
      ['B', "You're the best. Okay, now tell me about your week."],
    ],
    reflection: 'I just listened for once. I had no idea about her mom.',
    classify: { followUps: [3, 6, 8, 10], stories: [8], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you let Priya finish before sharing anything about your own week. When the chemo came up, you slowed down and asked about it.`,
      suggestion: 'After the Seattle trip next weekend, ask what Priya could and couldn\'t picture there before you give your opinion.',
      citedTurnIds: [6, 8],
    }),
    followUp: {
      text: "Text me your flight for next weekend and I'll drive you to the airport. Thinking about you and your mom, and good luck with the race in three weeks!",
      status: 'sent', sentAfterMin: 90,
    },
    face: {
      baseline: 0.15,
      reactions: { 1: 0.06, 3: 0.1, 6: 0.12, 8: 0.04, 10: 0.08, 12: 0.2 },
      away: { 7: 0.45 },
      nods: { 4: 1, 8: 0, 9: 2, 11: 1 },
    },
    insight: {
      moments: {
        6: { title: 'Tied every time', why: 'Repeating her words back, then asking, opened up the part she had not told anyone.' },
        8: { title: 'Slowing down', why: 'When something heavy comes up, one gentle question is enough; you did not rush past it.' },
        12: { title: 'An offer, not advice', why: 'Offering the airport ride was a concrete way to show up without telling her what to decide.' },
      },
      rewrites: [],
    },
  },

  {
    key: 'marcus-apartment',
    tag: 'friend',
    otherName: 'Marcus Bell',
    daysAgo: 18, at: '22:15',
    video: { mime: 'video/webm', offsetMs: 150 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', "Marcus! How's the new apartment?"],
      ['B', "Finally unpacked. The landlord is a nightmare though, the heater broke twice and he keeps saying he'll come Friday and then never shows up."],
      ['A', 'Ugh. Wait, did you hear that Tyler cheated on Dana? Apparently she found out at the formal.'],
      ['B', "Uh, I don't know, I'm not really close with them."],
      ['A', "Yeah, it's a whole thing. Anyway, are you still doing the pottery class?"],
      ['B', "Yeah, Thursdays. I'm making a set of mugs for my sister. Her wedding is in two months, and the hard part is the handles, every time I attach them they crack in the kiln and I have to"],
      ['A', 'Oh my god, speaking of the formal, you have to see the video Tyler posted.', { overlap: 900 }],
      ['B', 'Maybe later. I should get going, I have an early class.'],
      ['A', "Oh, okay. I'll text you about the game Saturday."],
      ['B', 'Sure.'],
    ],
    reflection: 'That went badly. I was trying to have something to talk about and it came out as gossip.',
    classify: { followUps: [], stories: [], reflections: 0 },
    coach: () => ({
      text: 'When Marcus brought up the landlord and the broken heater, you moved to a rumour about Tyler and Dana, and later cut in on the story about the wedding mugs.',
      suggestion: 'Next time, leave the rumour out and ask Marcus how the mugs for the wedding are coming along.',
      citedTurnIds: [3, 7],
    }),
    followUp: {
      text: "Hey Marcus, how are the mugs coming along? I want to hear about the handles and the kiln. And I'll text you about the game Saturday.",
      editedText: "Hey Marcus, sorry I cut you off about the mugs. How are the handles holding up in the kiln? I'll text you about the game Saturday.",
      status: 'sent', sentAfterMin: 720,
    },
    face: {
      baseline: 0.16,
      // the smile after the rumour is the nervous kind the context check is there for
      reactions: { 1: 0.05, 3: 0.06, 5: 0.02, 7: -0.09, 9: -0.05 },
      away: { 3: 0.5, 7: 0.6, 9: 0.5 },
      nods: { 2: 1 },
    },
    insight: {
      moments: {
        3: { title: 'The rumour', why: "Leave stories about people who aren't there out of it; ask about the heater instead." },
        7: { title: 'Cut in on the mugs', why: 'Let the handle story finish before you change the subject.' },
        2: { title: 'The heater', why: 'This was the opening: a landlord who never shows up is easy to ask about.' },
      },
      rewrites: [
        { turnId: 3, title: 'Leave the rumour out', tryInstead: 'He keeps saying Friday? Has the heater been fixed at all, or are you still cold?', because: 'Marcus had just told you about the heater; a question about it keeps the conversation about the two of you.' },
        { turnId: 7, title: 'Let them finish', tryInstead: 'Sorry, go on, the handles crack in the kiln?', because: 'Marcus was mid-sentence about the handles; letting it land, then asking about it, shows you were listening.' },
      ],
    },
  },

  {
    key: 'elena-coffee',
    tag: 'networking',
    otherName: 'Elena Ruiz',
    daysAgo: 15, at: '16:00',
    video: { mime: 'video/mp4', offsetMs: 260 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', 'Thanks so much for making time, Elena. How did you end up as a product manager at Lumen Health?'],
      ['B', "I was a nurse for six years first. I kept seeing nurses fight the charting software at three in the morning, and at some point I decided I'd rather fix it than complain about it."],
      ['A', "That's a big jump. I'm actually really interested in health tech too, I've been building an app for my research lab that tracks sleep data, and I'm hoping to find an internship where I can do something like that."],
      ['B', 'Nice. What does the app do with the data?'],
      ['A', 'It flags nights when students sleep under five hours before an exam. What was the hardest part of going from nursing to product?'],
      ['B', "Learning to say no. Nurses say yes to everything because someone's health depends on it. In product, if you say yes to everything, nothing ships."],
      ['A', 'Learning to say no, I like that. How do you decide what to say no to?'],
      ['B', "I ask whether it helps the nurse at three in the morning. If it doesn't, it waits. I'm actually presenting that framework at a conference in two weeks, in Denver."],
      ['A', "In Denver? What's the talk called?"],
      ['B', 'Ruthless for the night shift. My manager hates the title, so I\'m keeping it.'],
      ['A', "That's a great title. I'll send you the article about alarm fatigue from my HCI class, it's the same problem from the nurse's side."],
      ['B', "Please do. And send me your resume, I'll pass it to our intern lead."],
    ],
    reflection: 'Pitched myself too early again, but the Denver talk part was a real conversation.',
    classify: { followUps: [5, 7, 9], stories: [1], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and Elena told you about the nurses fighting the charting software. Right after that story you pitched your own app.`,
      suggestion: 'Next time someone tells you why they switched careers, ask one question about it before you mention your work.',
      citedTurnIds: [2, 3, 7],
    }),
    followUp: {
      text: 'Hi Elena, thank you for the coffee! Here is the alarm fatigue article I promised, and my resume is attached. Good luck in Denver with Ruthless for the night shift.',
      status: 'sent', sentAfterMin: 140,
    },
    face: {
      baseline: 0.2,
      reactions: { 1: 0.05, 3: -0.07, 5: 0.08, 7: 0.16, 9: 0.22, 11: 0.1 },
      away: { 3: 0.6 },
      nods: { 2: 1, 6: 2, 8: 1, 12: 1 },
    },
    insight: {
      moments: {
        3: { title: 'Pitching after her story', why: 'One question about the night shift would have come before your app.' },
        9: { title: 'The talk title', why: 'Asking about the talk, not the conference, got you the line you will both remember.' },
        7: { title: 'Saying no', why: 'Repeating her phrase back before asking showed you were following the idea, not waiting to talk.' },
      },
      rewrites: [
        { turnId: 3, title: 'Stay with the night shift', tryInstead: 'Nurses fighting the charting software at three in the morning? What did they do instead?', because: 'Elena had just explained the switch from nursing; one question about it would have kept that story going before your pitch.' },
      ],
    },
  },

  {
    key: 'mama-cirugia',
    tag: 'family',
    otherName: 'Mamá',
    daysAgo: 12, at: '20:45',
    video: null,
    lipLock: false,
    userLabel: 'A',
    lines: [
      ['A', 'Hola Mamá, ¿cómo están todos?'],
      ['B', 'Bien, mija, un poco nerviosa. La cirugía de tu papá es el próximo martes, la de la rodilla, y ya sabes cómo se pone él con los hospitales.'],
      ['A', 'Ay, yo también tengo mucho estrés con la escuela, tengo tres proyectos esta semana y no he dormido nada.'],
      ['B', 'Ay, mija, no te estreses. ¿Estás comiendo bien?'],
      ['A', 'Sí, sí. Oye, ¿y papá qué dice de la cirugía? ¿Tiene miedo?'],
      ['B', 'Dice que no, pero anoche no durmió. Le preguntó al doctor una y otra vez cuánto tiempo va a estar sin manejar. Para él no manejar es como no tener piernas.'],
      ['A', '¿Cuánto tiempo va a estar sin manejar?'],
      ['B', 'Seis semanas. Ya le dije que yo lo llevo a todos lados, pero él quiere que lo lleve tu tío porque según él yo manejo como taxista.'],
      ['A', 'Jaja, sí manejas como taxista. ¿Quieres que vaya a casa el fin de semana después de la cirugía para ayudar?'],
      ['B', 'Ay, sí mija, eso le alegraría mucho. Y a mí también.'],
      ['A', 'Te llamo el martes después de la cirugía.'],
      ['B', 'Gracias, mi amor. Cuídate mucho y come algo, ¿eh?'],
    ],
    reflection: 'I made her nerves about me for a second. Asked about papá after.',
    classify: { followUps: [5, 7, 9], stories: [5], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups about your dad's surgery. When she told you it was next Tuesday, your first answer was about your projects.`,
      suggestion: 'On Tuesday, ask how she is holding up too: “¿Y tú cómo estás con todo esto?”',
      citedTurnIds: [3, 5, 7],
    }),
    followUp: {
      text: 'Mamá, te llamo el martes después de la cirugía. Y el fin de semana voy a casa para ayudar con papá. Te quiero.',
      status: 'sent', sentAfterMin: 15,
    },
    face: null,
    insight: {
      moments: {
        3: { title: 'Your stress, not hers', obs: 'She said the surgery is next Tuesday and your next line was about your three projects.', why: 'Ask about the surgery, and about her, before your own week.' },
        5: { title: 'Back to papá', obs: '“¿Y papá qué dice de la cirugía?” brought back the surgery and got the longest answer of the call.', why: 'Going back to what she said is always available, even after a detour.' },
      },
      rewrites: [
        { turnId: 3, title: 'Ask about the surgery first', tryInstead: '¿La cirugía de papá es el martes? ¿Y tú cómo estás con eso?', because: 'She had just told you about the surgery; a question about it, and about her, would have come before your week.' },
      ],
    },
  },

  {
    key: 'jordan-interview',
    tag: 'friend',
    otherName: 'Jordan Lee',
    daysAgo: 9, at: '22:05',
    video: { mime: 'video/mp4', offsetMs: 220 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', 'So? How did the Verdant interview go?!'],
      ['B', "I think it went well? The whiteboard part was actually fine because we practiced. I drew the forecasting pipeline and didn't freeze once."],
      ['A', "You didn't freeze once! What did they ask you to design?"],
      ['B', 'A system that predicts solar output for every rooftop in Austin. I started with the weather data like you said, and the interviewer literally said that is how their team does it.'],
      ['A', 'Wait, the interviewer said that is how their team does it? That has to be a good sign.'],
      ['B', "Maybe. The recruiter said I'll hear back about the final step tomorrow. I'm trying not to refresh my email every five minutes."],
      ['A', "That's so exciting. What happens in the final step?"],
      ['B', 'Lunch with the team lead. Which is scarier than the whiteboard honestly, I never know what to talk about at those.'],
      ['A', "Ask the team lead about their favorite forecasting failure, people love telling those. And I'll grab you a coffee tomorrow morning so you're not refreshing alone."],
      ['B', 'Deal. Thank you for the practice, seriously. It made a difference.'],
    ],
    reflection: 'This felt like the best one. I remembered everything from last time.',
    classify: { followUps: [3, 5, 7], stories: [3], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you opened with the interview you two practiced for. Jordan walked you through the rooftop solar question after your first follow-up.`,
      suggestion: 'Tomorrow, ask Jordan what they want to learn from the team lead at lunch before you suggest what to ask.',
      citedTurnIds: [1, 3, 5],
    }),
    followUp: {
      text: "Coffee's on me tomorrow morning. Good luck with the final step, and remember you didn't freeze once at the whiteboard!",
      status: 'sent', sentAfterMin: 10,
    },
    face: {
      baseline: 0.19,
      reactions: { 1: 0.12, 3: 0.2, 5: 0.24, 7: 0.1, 9: 0.18 },
      away: {},
      nods: { 2: 1, 4: 2, 6: 1, 10: 1 },
    },
    insight: {
      moments: {
        5: { title: 'Their words back', why: 'Repeating the interviewer\'s line back got the biggest reaction of the night.' },
        3: { title: "Didn't freeze once", why: 'Starting from the thing you practiced together made it easy for Jordan to tell the story.' },
        9: { title: 'Advice, then coffee', why: 'Next time, ask what Jordan wants from the lunch before you suggest a question.' },
      },
      rewrites: [],
    },
  },

  {
    key: 'abuela-altar',
    ...abuela,
    daysAgo: 6, at: '18:30',
    video: { mime: 'video/mp4', offsetMs: 280 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', "Hola Abuela! I've been thinking about the mole since you told me about the metate. ¿Me enseñas la receta?"],
      ['B', '¡Claro que sí! But it is not a recipe, mija, it is a whole day. Twenty-six ingredients, and the chiles have to be toasted until the whole house smells like smoke.'],
      ['A', 'Twenty-six ingredients? Which chile is the hardest to get here?'],
      ['B', "The chilhuacle negro. You can only find it in Oaxaca, so Lupe brings it in her suitcase. She's coming next month, for Día de Muertos."],
      ['A', 'Tía Lupe is coming for Día de Muertos? Will you make the altar together?'],
      ['B', 'Sí, every year we put the altar for my mother and father. Pan de muerto, cempasúchil, and a little cup of mezcal for my father because he would be angry without it.'],
      ['A', 'A cup of mezcal for your father, I love that. What was he like?'],
      ['B', 'Stubborn like your papá. He sold corn in the market in Oaxaca and he knew every family by name. When he laughed the whole market could hear it.'],
      ['A', "I'll bring the pan de muerto for the altar this year. Can you teach me how to put the cempasúchil on the altar?"],
      ['B', 'Ay, mija, sí. Your great-grandfather would be so proud.'],
    ],
    reflection: 'I finally asked about the mole like the app told me weeks ago. Best call in a while.',
    classify: { followUps: [3, 5, 7, 9], stories: [5, 7], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you opened with the mole she told you about weeks ago. She told ${s.storiesAfterQuestions} stories, about the altar and her father in the market.`,
      suggestion: 'When Tía Lupe visits next month, ask them both for one story about the market in Oaxaca, and write down the words you don\'t know.',
      citedTurnIds: [1, 5, 7],
    }),
    followUp: {
      text: "Abuela, I'll bring the pan de muerto for the altar. Can't wait to see you and Tía Lupe next month and learn the cempasúchil.",
      status: 'sent', sentAfterMin: 25,
    },
    face: {
      baseline: 0.16,
      reactions: { 1: 0.14, 3: 0.15, 5: 0.22, 7: 0.25, 9: 0.2 },
      away: {},
      nods: { 2: 1, 6: 2, 8: 3, 10: 1 },
    },
    insight: {
      moments: {
        7: { title: 'What was he like?', why: 'An open question about a person she loves got the warmest story of the month.' },
        1: { title: 'The mole, weeks later', why: 'Bringing back something from an earlier call is the strongest follow-up there is.' },
        5: { title: 'Día de Muertos', why: 'Picking up the visit she mentioned in passing led straight to the altar.' },
      },
      rewrites: [],
    },
  },

  {
    key: 'daniel-junk-drawer',
    tag: 'networking',
    otherName: 'Daniel Okafor',
    daysAgo: 4, at: '11:00',
    video: { mime: 'video/webm', offsetMs: 120 },
    lipLock: false,
    userLabel: 'A',
    lines: [
      ['A', 'Hi Daniel, thanks again for passing my resume along. How have things been on the warehouse team?'],
      ['B', "Busy. We're rolling out the new picking arm to the Dallas warehouse next week, so everyone is living in the test cell right now."],
      ['A', 'The new arm, is that the one that handles the crushed boxes?'],
      ['B', "That's the one. It catches about nine out of ten now. The last ten percent is the fun part, it's all the weird stuff like shrink wrap that reflects the depth camera."],
      ['A', 'Shrink wrap reflects the depth camera? How do you even collect data on that?'],
      ['B', "We built a little cart we call the junk drawer. It's full of the worst packages we've ever seen and we run it past the arm every night. Honestly it's my favorite part of the job."],
      ['A', 'The junk drawer is such a good name. Would an intern get to work on that?'],
      ['B', "Probably, yes. The recruiter told me your first interview is next Thursday, so ask them about the failure lab, they'll be impressed you know about it."],
      ['A', "I will. I'll send you a thank you note after the interview and tell you how it went."],
      ['B', "Sounds good. And don't over-prepare, just talk about the satellite project like you did at the booth."],
    ],
    reflection: 'Way better than the career fair. I asked about his stuff first.',
    classify: { followUps: [3, 5, 7], stories: [5], reflections: 0 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups, and you brought back the crushed boxes from the career fair. Daniel told you about the junk drawer cart after one of them.`,
      suggestion: 'In the interview next Thursday, ask about the failure lab before you talk about the satellite project.',
      citedTurnIds: [3, 5, 7],
    }),
    followUp: {
      text: "Thanks again, Daniel. I'll ask about the failure lab and the junk drawer next Thursday, and I'll send you a note after the interview. Good luck with the Dallas rollout next week!",
      status: 'draft',
    },
    face: {
      baseline: 0.2,
      reactions: { 1: 0.08, 3: 0.12, 5: 0.18, 7: 0.15, 9: 0.08 },
      away: {},
      nods: { 4: 1, 6: 2, 8: 1 },
    },
    insight: {
      moments: {
        3: { title: 'Bringing back the boxes', why: 'Remembering the crushed boxes from the booth showed him you were listening two weeks ago.' },
        5: { title: 'The junk drawer', why: 'A question about the weird cases got you the part of the job he likes most.' },
        7: { title: 'Asking at the right time', why: 'You asked about interning only after three questions about his work.' },
      },
      rewrites: [],
    },
  },

  {
    key: 'priya-race',
    tag: 'friend',
    otherName: 'Priya Nair',
    daysAgo: 2, at: '19:30',
    video: { mime: 'video/mp4', offsetMs: 190 },
    lipLock: true,
    userLabel: 'A',
    lines: [
      ['A', 'You finished! How was the race?'],
      ['B', 'Two hours and three minutes. I wanted under two, but my mom watched the livestream from her chemo chair and texted me the whole time, so honestly it was perfect.'],
      ['A', 'Your mom texted you from the chemo chair? What did she say?'],
      ['B', "Mostly 'run faster' in all caps. And at mile ten she sent a picture of the nurses holding up a sign with my name on it."],
      ['A', 'The nurses made a sign? I am going to cry. Did you decide about Seattle?'],
      ['B', "I'm taking it. But I asked them to let me start in March so I can be in Houston for her last rounds of treatment, and they said yes."],
      ['A', "They said yes to March, that's amazing. How are you feeling about it now?"],
      ['B', "Relieved. Scared too. I keep thinking about leaving the running group, they're kind of my people here."],
      ['A', "What if we do one last long run with the running group before you go? I'll find a route and send it to you."],
      ['B', 'Yes. Something with tacos at the end.'],
    ],
    reflection: 'So happy for her. I want to ask more about the running group next time.',
    classify: { followUps: [3, 5, 7, 9], stories: [3], reflections: 1 },
    coach: s => ({
      text: `You asked ${s.userQuestions} questions and ${s.followUps} were follow-ups. Priya told you about the nurses holding up the sign at mile ten after your question about the texts.`,
      suggestion: 'Next time, ask Priya what would make the move to Seattle feel less scary before suggesting a plan.',
      citedTurnIds: [3, 7, 9],
    }),
    followUp: {
      text: "I'll find a route for one last long run with the running group and send it to you, tacos at the end. So happy the March start worked out.",
      status: 'draft',
    },
    face: {
      baseline: 0.17,
      reactions: { 1: 0.16, 3: 0.25, 5: 0.2, 7: 0.05, 9: 0.22 },
      away: { 8: 0.4 },
      nods: { 2: 1, 4: 2, 6: 1, 10: 1 },
    },
    insight: {
      moments: {
        3: { title: 'The chemo chair', why: 'Asking about the detail she slipped in got the best story of the race.' },
        7: { title: 'How it feels now', why: 'After good news, asking how it feels opened up the part about leaving.' },
        9: { title: 'One last run', why: 'Next time, ask what she will miss most about the group before planning anything.' },
      },
      rewrites: [],
    },
  },
];

// Weekly goals, in the order the next-step agent proposes them, and what the user did with each.
// `after` is the conversation the action happened after.
export const SYNTHETIC_GOALS = [
  {
    text: 'Ask one follow-up question before sharing your own news, in each conversation this week.',
    actions: [{ after: 'abuela-seeds', action: 'accept' }, {
      after: 'marcus-apartment', action: 'change',
      text: "Ask one question about what they just said before changing the subject, and skip stories about people who aren't there.",
    }],
  },
  {
    text: 'Ask two clear questions about their work before you mention yours, in each networking chat this week.',
    actions: [{ after: 'jordan-interview', action: 'dismiss' }],
  },
  {
    text: 'Ask at least 4 follow-up questions in each conversation this week, starting with something they told you last time.',
    actions: [{ after: 'abuela-altar', action: 'accept' }],
  },
];
