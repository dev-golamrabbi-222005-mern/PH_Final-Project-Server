const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require('express');
const cors = require("cors");
const app = express();
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const crypto = require('crypto');
const admin = require("firebase-admin");
const serviceAccount = require("./zapshift-firebase-admin-key.json");
const { error } = require("console");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = 'ZAP';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}


const port = process.env.PORT || 3333;

//middleware
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) =>{
    const token = req.headers.authorization;

    if(!token){
      return res.status(401).send({message: 'Un-Authorized Access'})
    }
    try{
      const idToken = token.split(' ')[1];
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.decoded_email = decoded.email;
      
    }
    catch(error){
      return res.status(401).send({message: 'Un-Authorized Access'})
    }

  next();
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.gh1jtid.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();
    const db = client.db('Zap-Shift_DB');
    const parcelsCollection = db.collection('parcels');
    const paymentsCollection = db.collection('payments');
    const usersCollection = db.collection('users');
    const ridersCollection = db.collection('riders');

    //users API
    app.post('/users', async(req, res)=>{
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();

      const email = user.email;
      const existsUser = await usersCollection.findOne({email});
      if(existsUser){
        return res.send({message: 'user exists'});
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    })

    app.get("/users/role", async(req, res)=>{
      try{
        const email = req.query.email;
        if(email !== req.decoded_email){
          return res.status(403).send({message: "Forbidden Access"});
        }
        const user = await usersCollection.findOne({email});
        res.send({role: user?.role});
      }
      catch (error) {
        res.status(500).send({ error: error.message });
      }
    })

 app.get("/users/:email", verifyFirebaseToken, async (req, res) => {
   try {
     const email = req.params.email;

     if (email !== req.decoded_email) {
       return res.status(403).send({ message: "Forbidden Access" });
     }

     const user = await usersCollection.findOne({ email });

     if (!user) {
       return res.status(404).send({ message: "User not found" });
     }

     res.send(user);
   } catch (error) {
     res.status(500).send({ error: error.message });
   }
 });

    //parcels API
    app.get('/parcels', async (req, res)=>{
        const query = {}
        const {email} = req.query;
        if(email){
            query.senderEmail = email;
        }
        const cursor = parcelsCollection.find(query);
        const result = await cursor.toArray();
        res.send(result);
    })

    app.get('/parcels/:id', async(req, res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)};
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    })

    app.post('/parcels', async (req, res)=>{
        const parcel = req.body;
        // Parcel creation time
        parcel.createdAt = new Date();
        parcel.deliveryStatus = 'pending-pickup'
        const result = await parcelsCollection.insertOne(parcel);
        res.send(result);
    })

app.patch("/parcels/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const id = req.params.id;
    const { deliveryStatus, assignedRider } = req.body;

    const query = { _id: new ObjectId(id) };
    const updates = {
      $set: {
        ...(deliveryStatus && { deliveryStatus }),
        ...(assignedRider && { assignedRider }),
        updatedAt: new Date(),
      },
    };

    const result = await parcelsCollection.updateOne(query, updates);

    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "Parcel not found" });
    }

    res.send({ success: true, result });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

    app.delete('/parcels/:id', async (req, res)=>{
      const id = req.params.id;
      const query = {_id: new ObjectId(id)}
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    })

    // payment section's api
    app.post('/zapshift-checkout-session', async(req, res)=>{
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({url: session.url});
    })

   app.patch("/verify-payment-success", async (req, res) => {
     try {
       const sessionId = req.query.session_id;

       if (!sessionId) {
         return res
           .status(400)
           .send({ success: false, message: "Session ID is required" });
       }

       const session = await stripe.checkout.sessions.retrieve(sessionId);
       //  console.log(session);

       const transactionId = session.payment_intent;
       const query = {transactionId: transactionId};
       const paymentExist = await paymentsCollection.findOne(query);
       if(paymentExist){
        return res.send({message: 'already exists', transactionId});
       }
       
       if (session.payment_status === "paid") {
         const id = session.metadata.parcelId;
         const trackingId = generateTrackingId(); // Generate tracking ID here
         const query = { _id: new ObjectId(id) };
         const update = {
           $set: {
             paymentStatus: "paid",
             trackingId: trackingId, // Use the generated trackingId
           },
         };
         const result = await parcelsCollection.updateOne(query, update);

         const payment = {
           amount: session.amount_total / 100,
           currency: session.currency,
           customerEmail: session.customer_email,
           parcelId: session.metadata.parcelId,
           parcelName: session.metadata.parcelName,
           transactionId: session.payment_intent,
           paymentStatus: session.payment_status,
           trackingId: trackingId, // Add tracking ID to payment record
           paidAt: new Date(),
         };

         const resultPayment = await paymentsCollection.insertOne(payment);

         // Send response
         return res.send({
           success: true,
           modifyParcel: result,
           trackingId: trackingId, 
           transactionId: session.payment_intent,
           paymentInfo: resultPayment,
         });
       } else {
         return res.send({
           success: false,
           message: "Payment not completed",
           paymentStatus: session.payment_status,
         });
       }
     } catch (error) {
       console.error("Payment verification error:", error);
       res.status(500).send({ success: false, error: error.message });
     }
   });

   //Payment history related api
   app.get('/payments', verifyFirebaseToken, async(req, res)=>{
    const email = req.query.email;
    const query={}
    if(email){
      query.customerEmail = email;
      if(email !== req.decoded_email){
        return res.status(403).send({message: 'Forbidden Access'})
      }
    }

    const cursor = paymentsCollection.find(query).sort({paidAt: -1});
    const result = await cursor.toArray();
    res.send(result);
   })

   //riders related API
   app.post('/riders', async(req, res)=>{
    const rider = req. body;
    rider.createdAt = new Date();
    const result = await ridersCollection.insertOne(rider);
    res.send(result);
   })

   app.get('/riders', async(req, res)=>{
    // const query = {applicationStatus: 'Approved'}
    const cursor = ridersCollection.find();
    const result = await cursor.toArray();
    res.send(result);
   })

app.patch("/riders/:id", verifyFirebaseToken, async (req, res) => {
  try {
    const status = req.body.applicationStatus;
    const id = req.params.id;

    // Check if user is admin (you need to implement this check)
    const user = await usersCollection.findOne({ email: req.decoded_email });
    if (user.role !== "admin") {
      return res.status(403).send({ message: "Admin access required" });
    }

    const query = { _id: new ObjectId(id) };
    const updates = {
      $set: {
        applicationStatus: status,
        reviewedAt: new Date(),
        reviewedBy: req.decoded_email,
      },
    };

    const result = await ridersCollection.updateOne(query, updates);
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

   app.patch(
     "/parcels/:id/assign-rider",
     verifyFirebaseToken,
     async (req, res) => {
       try {
         const parcelId = req.params.id;
         const { riderEmail } = req.body;

         // Verify rider exists and is approved
         const rider = await ridersCollection.findOne({
           email: riderEmail,
           applicationStatus: "Approved",
         });

         if (!rider) {
           return res.status(404).send({ message: "Approved rider not found" });
         }

         const query = { _id: new ObjectId(parcelId) };
         const updates = {
           $set: {
             assignedRider: riderEmail,
             deliveryStatus: "in-transit",
             assignedAt: new Date(),
           },
         };

         const result = await parcelsCollection.updateOne(query, updates);
         res.send({ success: true, result });
       } catch (error) {
         res.status(500).send({ error: error.message });
       }
     },
   );

   app.get("/statistics", verifyFirebaseToken, async (req, res) => {
     try {
       const user = await usersCollection.findOne({ email: req.decoded_email });

       let query = {};

       // If customer, only show their parcels
       if (user.role === "customer") {
         query.senderEmail = req.decoded_email;
       }

       // If rider, show their assigned parcels
       if (user.role === "delivery") {
         query.assignedRider = req.decoded_email;
       }

       const parcels = await parcelsCollection.find(query).toArray();
       const payments = await paymentsCollection
         .find(
           user.role === "admin" ? {} : { customerEmail: req.decoded_email },
         )
         .toArray();

       const riders =
         user.role === "admin" ? await ridersCollection.find().toArray() : [];

       // Calculate statistics
       const stats = {
         totalParcels: parcels.length,
         pendingParcels: parcels.filter(
           (p) => p.deliveryStatus?.toLowerCase() === "pending-pickup",
         ).length,
         inTransitParcels: parcels.filter((p) =>
           p.deliveryStatus?.toLowerCase().includes("transit"),
         ).length,
         deliveredParcels: parcels.filter(
           (p) => p.deliveryStatus?.toLowerCase() === "delivered",
         ).length,
         totalRevenue: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
         activeRiders: riders.filter((r) => r.applicationStatus === "Approved")
           .length,
         pendingRiders: riders.filter((r) => r.applicationStatus === "Pending")
           .length,
       };

       res.send(stats);
     } catch (error) {
       res.status(500).send({ error: error.message });
     }
   });

    // await client.db("admin").command({ ping: 1 });
    // console.log(
      // "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res)=>{
    res.send("Zap is Shifting..!!!");
})

app.listen(port, ()=>{
    // console.log(`Server is running on port: ${port}`);
})