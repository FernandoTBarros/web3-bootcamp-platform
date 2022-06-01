const functions = require('firebase-functions')
const { sendEmail } = require('./emails')
const { PubSub } = require('@google-cloud/pubsub')
const admin = require('firebase-admin')
const { addDiscordRole } = require('./discord_integration')

admin.initializeApp()

const db = admin.firestore()

const pubsub = new PubSub()

exports.sendEmail = functions.https.onRequest(async (req, resp) => {
  const subject =
    req.query.subject || '🏕️ Seu primeiro Smart Contract na Ethereum'
  resp.send(await sendEmail(req.query.template, subject, req.query.to))
})

exports.sendNFTEmails = functions.https.onRequest(async (req, resp) => {
  const subject = '👷👷‍♀️ WEB3DEV - NFT Recebido: Smart Contract Solidity'

  people = require('../nfts/scripts/people.json')

  for (let i = 0; i < people.length; i++) {
    p = people[i]
    sendEmail('nft_delivery.js', subject, p.email, {
      course_title: 'Smart Contract Solidity',
      wallet_address: p.wallet,
      nft_contract: '0xa68580d4e41925c20af20dba9b4db17a79842f19',
      nft_id: i + 2,
    })
  }

  resp.send({ ok: 200 })
})

async function docData(collection, doc_id) {
  return (await db.collection(collection).doc(doc_id).get()).data();
}

async function emailParams(cohort) {
  return {
    cohort: await docData("cohorts", cohort.cohort_id),
    course: await docData("courses", cohort.course_id),
  };
}

exports.onCohortSignup = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const previousUserValue = change.before.data();
    const user = change.after.data();
    const previousCohortData = previousUserValue.cohorts.map((item) => item?.cohort_id);
    const userNewCohorts = user.cohorts.filter(
      (item) => !previousCohortData?.includes(item.cohort_id)
    );

    for (let cohortSnapshot of userNewCohorts) {
      const params = emailParams(cohortSnapshot);
      //todo essas funções deveriam ser enfileiradas num pubsub para evitar falhas
      await Promise.all([
        sendEmail("on_cohort_signup.js", params.cohort.email_content.subject, user.email, params),
        addDiscordRole(user?.discord?.id, params.cohort.discord_role),
      ]);
    }
  });

exports.onDiscordConnect = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const previousUserValue = change.before.data();
    const newUserValue = change.after.data();

    function userConnectedDiscord() {
      return newUserValue.discord?.id && newUserValue.discord?.id !== previousUserValue.discord?.id;
    }

    if (!userConnectedDiscord()) return;

    const cohorts = db.collection("cohorts");

    for (let cohortSnapshot of newUserValue.cohorts) {
      const params = {
        cohort: (await cohorts.doc(cohortSnapshot.cohort_id).get()).data(),
      };
      //todo essas funções deveriam ser enfileiradas num pubsub para evitar falhas
      await Promise.all([addDiscordRole(newUserValue?.discord?.id, params.cohort.discord_role)]);
    }
  });

exports.sendEmailJob = functions.pubsub.topic("course_day_email").onPublish((message) => {
  const data = JSON.parse(Buffer.from(message.data, "base64"));

  console.log(`Sending message ${data.subject} template ${data.template} to ${data.to}`);

  return sendEmail(data.template, data.subject, data.to, data.params);
});

exports.sendEmailToAllUsersInCohort = functions.https.onRequest(async (req, resp) => {
  db.collection("users")
    .get()
    .then((querySnapshot) => {
      console.log(querySnapshot.size);
      const emails = querySnapshot.docs.map(async (doc) => {
        const user = doc.data();
        const userCohort = user.cohorts.find((cohort) => cohort.cohort_id === req.query.cohort_id);
        if (!userCohort || !user.email) return 0;
        const cohort = await docData("cohorts", userCohort.cohort_id);
        if (cohort) {
          const messageObject = {
            to: user.email,
            template: req.query.template,
            subject: cohort.email_content.subject,
            params: await emailParams(userCohort),
          };
          const messageBuffer = Buffer.from(JSON.stringify(messageObject), "utf8");

          pubsub.topic("course_day_email").publishMessage({ data: messageBuffer });
        }
        return 1;
      });
      Promise.all(emails).then((results) => {
        console.log("Sent emails: " + results.reduce((acc, curr) => acc + curr, 0));
      });
    });
  resp.send("OK");
});

exports.addUserToDiscord = functions.https.onRequest(async (req, resp) => {
  addUserToRole(req.query.user_id, req.query.role_id).then((r) =>
    resp.send('OK')
  )
})

exports.kickoffEmail = functions.pubsub.schedule('55 * * * *').onRun((context) => {
  let cohortObj = {}
    await db.collection('cohorts').get().then(cohorts => {
      cohorts.forEach(async cohort => {
        const data = cohort.data()
        const diff = ((new Date(data.kickoffStartTime.toDate().toLocaleString()).getTime()) - new Date().getTime()) / 1000
        if(diff > 0 && diff < 360) return cohortObj = cohort
      })
    })
    const params = { cohort: cohortObj?.data(), course: (await db.collection('courses').doc(cohortObj?.data().course_id).get()).data() }
    db.collection('users').get().then(users => {
      users.forEach(user => {
        const userData = user.data()
        const currentCohort = userData.cohorts.find(userCohort => userCohort.cohort_id === cohortObj?.id)
        if(userData.cohorts && currentCohort.cohort_id === cohortObj?.id && userData.email == 'biorrodrigues@gmail.com') {
          sendEmail('kickoff_email.js', data.email_content.subject, userData.email, params)
        }
      })
    })
})

exports.addAllUsersFromCohortToDiscord = functions.https.onRequest(
  async (req, resp) => {
    const cohort_id = req.query.cohort_id
    const cohort = (await db.collection('cohorts').doc(cohort_id).get()).data()

    if (!cohort) {
      console.log('invalid cohort')
      return resp.send('invalid cohort')
    }

    const users = await db.collection('users').get()

    if (users.empty) {
      console.log('no users to change')
      return resp.send('no users')
    }

    users.forEach(async (doc) => {
      const data = doc.data()
      if (
        data.cohorts &&
        data.cohorts[0] &&
        data?.discord?.id &&
        data.cohorts[0].cohort_id === cohort_id
      ) {
        console.log(
          `Adicionando role ${cohort.discord_role} do curso no discord: ${data.discord.username}`
        )
        try {
          await addDiscordRole(data.discord.id, cohort.discord_role)
        } catch (exception) {
          console.log(exception)
        }
      }
    })
    resp.send('OK')
  }
)
