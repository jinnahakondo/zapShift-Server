const express = require('express')
const app = express()
const port = process.env.PORT || 5000
require('dotenv').config()
// stripe 
const stripe = require('stripe')(process.env.STRIPE_KEY);


// Function to generate tracking ID
function generateTrackingId() {
    const timestamp = Date.now().toString(36);           // timestamp in base36
    const random = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4-char random
    return `P-${timestamp}-${random}`;
}


// firebase

const admin = require("firebase-admin");

const serviceAccount = require("./zapshift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});



// middleWere 
cors = require('cors')
app.use(express.json())
app.use(cors())

const verifyFBToken = async (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
    const token = authorization.split(' ')[1]
    try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.token_email = decoded.email;
        next()
    } catch (error) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
}



// mongodb 
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.URI;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const run = async () => {
    try {
        const ZapShiftDB = client.db('ZapShiftDB');
        const usersColl = ZapShiftDB.collection('users')
        const riderColl = ZapShiftDB.collection('riders')
        const parcelsColl = ZapShiftDB.collection('ParcelColl')
        const paymentCollection = ZapShiftDB.collection('payments')
        const trackingCollection = ZapShiftDB.collection('trackings')

        // verify admin 
        const verifyAdmin = async (req, res, next) => {
            const email = req.token_email;
            const user = await usersColl.findOne({ email });
            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next()
        }


        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('-').join(' '),
                createdAt: new Date(),
            }
            const resuslt = await trackingCollection.insertOne(log)
            return resuslt;
        }

        //user
        app.post('/users', async (req, res) => {
            const user = req.body;
            const { email } = user;
            const existUser = await usersColl.findOne({ email })
            if (existUser) {
                return res.send({ message: 'user already exist' })
            }
            user.role = 'user';
            user.createdAt = new Date();
            const result = await usersColl.insertOne(user);
            res.send(result)
        })


        app.get('/users', async (req, res) => {
            const searchText = req.query.search;
            const query = {};
            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }
            const result = await usersColl.find(query).toArray();
            res.send(result)
        })

        // get user with email 
        app.get('/user/:email/role', async (req, res) => {
            const { email } = req.params;
            const result = await usersColl.findOne({ email });
            res.send(result)
        })

        //update user role
        app.patch('/user/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const role = req.body
            const update = {
                $set: role
            }
            const result = await usersColl.updateOne({ _id: new ObjectId(id) }, update)
            res.send(result)
        })

        // get rider 
        app.get('/riders', async (req, res) => {
            const { region, status, workStatus } = req.query;

            const query = {}

            if (region) {
                query.region = region;
            }
            if (status) {
                query.status = status;
            }
            if (workStatus) {
                query.workingStatus = workStatus
            }

            const result = await riderColl.find(query).toArray();
            res.send(result)
        })

        app.get('/riders/delivery-per-day', async (req, res) => {
            const email = req.query.email;

            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        delevaryStatus: "parcel_delivred"
                    }
                },
                {
                    $lookup: {
                        from: 'trackings',
                        localField: 'trackingId',
                        foreignField: 'trackingId',
                        as: 'parcel_trackings'
                    }
                },
                { $unwind: "$parcel_trackings" },

                // Only delivered tracking records
                {
                    $match: {
                        "parcel_trackings.status": "parcel_delivred"
                    }
                },

                // Group by createdAt date
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$parcel_trackings.createdAt"
                            }
                        },
                        deliveredCount: { $sum: 1 }
                    }
                },

                // Sort by date
                { $sort: { "_id": 1 } }
            ];

            const result = await parcelsColl.aggregate(pipeline).toArray();
            res.send(result);
        });



        // post rider 
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending';
            rider.submitedAt = new Date();
            const result = await riderColl.insertOne(rider);
            res.send(result)
        })

        // approve as a rider 
        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const query = { _id: new ObjectId(id) }
            const update = {
                $set: {
                    status: 'approved',
                    workingStatus: 'avilable'
                }
            }
            const result = await riderColl.updateOne(query, update)

            // update user role as rider
            const { email } = req.body;

            const updateRol = await usersColl.updateOne({ email }, {
                $set: {
                    role: 'rider'
                }
            })

            res.send(result)
        })

        //delete riders
        app.delete('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params;
            const result = await riderColl.deleteOne({ _id: new ObjectId(id) })
            res.send(result)
        })

        // get all parcel 
        app.get('/parcel', async (req, res) => {
            const { email, delevaryStatus } = req.query;
            const query = {}
            if (email) {
                query.SenderEmail = email
            }
            if (delevaryStatus) {
                query.delevaryStatus = delevaryStatus;
            }
            const result = await parcelsColl.find(query).toArray()
            res.send(result)
        })


        //get a single percel
        app.get('/parcel/:id', async (req, res) => {
            const { id } = req.params;
            const result = await parcelsColl.findOne({ _id: new ObjectId(id) })
            res.send(result)
        })

        // post a parcel 
        app.post('/parcel', async (req, res) => {
            const newParcel = req.body;

            newParcel.trackingId = generateTrackingId();
            newParcel.CreatedAt = new Date();

            logTracking(newParcel.trackingId, 'parcel_Created')

            const result = await parcelsColl.insertOne(newParcel)
            res.send(result)
        })

        //delete a parcel
        app.delete('/parcel/:id', async (req, res) => {
            const id = req.params.id;
            const result = await parcelsColl.deleteOne({ _id: new ObjectId(id) })
            res.send(result)
        })

        //get parcel group for ...
        app.get('/parcels/delivery-status/stats', async (req, res) => {
            const pipeline = [
                {
                    $group: {
                        _id: '$delevaryStatus',
                        count: { $sum: 1 }
                    }
                }, {
                    $project: {
                        status: '$_id',
                        count: 1,
                        // _id:0
                    }
                }
            ]

            const result = await parcelsColl.aggregate(pipeline).toArray();
            res.send(result)
        })

        // assigned parcel 
        app.get('/parcels/riders', async (req, res) => {
            const { riderEmail, delevaryStatus } = req.query;
            const query = {}
            if (riderEmail) {
                query.riderEmail = riderEmail;
            }
            if (delevaryStatus !== "parcel_delivred") {
                query.delevaryStatus = { $nin: ["parcel_delivred"] };
            }
            else {
                query.delevaryStatus = "parcel_delivred"
            }
            const result = await parcelsColl.find(query).toArray();
            res.send(result)
        })


        app.patch('/parcels/:id', async (req, res) => {
            const { riderEmail, riderName, riderId, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const update = {
                $set: {
                    delevaryStatus: 'assigned-to-rider',
                    riderId,
                    riderName,
                    riderEmail
                }
            }
            const result = await parcelsColl.updateOne(query, update)

            //update rider
            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdate = {
                $set: {
                    workingStatus: "in_delivery"
                }
            }
            const riderResult = await riderColl.updateOne(riderQuery, riderUpdate);

            logTracking(trackingId, "assigned-to-rider");

            res.send(riderResult)
        })

        app.patch('/parcels/:id/status', async (req, res) => {
            const { id } = req.params;
            const { status, riderId, trackingId } = req.body;
            const update = {
                $set: { delevaryStatus: status }
            }

            if (status === "parcel_delivred") {
                const riderQuery = { _id: new ObjectId(riderId) }

                const riderUpdate = {
                    $set: {
                        workingStatus: "avilable"
                    }
                }
                const riderResult = await riderColl.updateOne(riderQuery, riderUpdate)


            }

            const result = await parcelsColl.updateOne({ _id: new ObjectId(id) }, update);
            logTracking(trackingId, status);
            res.send(result)

        })



        // payment related apis here
        app.post('/payment-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = Number(paymentInfo.Cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: `please pay for ${paymentInfo.ParcelName}`
                            }
                        },

                        quantity: 1,
                    },

                ],
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.ParcelName,
                    trackingId: paymentInfo.trackingId
                },
                mode: 'payment',
                customer_email: paymentInfo.SenderEmail,
                success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-canceld`,
            })
            res.send({ url: session.url })
        })


        //verify payment success
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            const trackingId = session.metadata.trackingId;

            const query = { transectionId: session.payment_intent }
            const paymentExist = await paymentCollection.findOne(query)

            if (paymentExist) {
                return res.send({ message: 'already exist' })
            }

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        PaymentStatus: 'paid',
                        paid_at: new Date(),
                        delevaryStatus: "pending-pickup",
                    }
                }

                const result = await parcelsColl.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transectionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date()
                }

                if (session.payment_status === 'paid') {
                    const resultpayment = await paymentCollection.insertOne(payment)
                    logTracking(trackingId, "pending-pickup")
                    res.send({
                        success: true,
                        modifyParcel: result,
                        paymentInfo: resultpayment,
                        trackingId: trackingId,
                        transectionId: session.payment_intent,
                    })
                }
            }
            res.send({ success: false })
        })

        app.get('/payments', verifyFBToken, async (req, res) => {

            const { email } = req.query;
            const query = {}
            if (email) {
                if (email !== req.token_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }
                query.customerEmail = email;
            }
            const result = await paymentCollection.find(query).sort({
                paidAt: -1
            }).toArray();
            res.send(result)
        })

        // tracking related apis 
        app.get('/track-parcel/:trackingId', async (req, res) => {
            const { trackingId } = req.params;
            const result = await trackingCollection.find({ trackingId }).toArray();
            res.send(result)
        })



        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    }
    finally { }
}
run().catch(console.dir);




app.get('/', (req, res) => {
    res.send('Hello World!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

