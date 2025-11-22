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



// middleWere 
cors = require('cors')
app.use(express.json())
app.use(cors())

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
        await client.connect();
        const ZapShiftDB = client.db('ZapShiftDB');
        const parcelsColl = ZapShiftDB.collection('ParcelColl')
        const paymentCollection = ZapShiftDB.collection('payments')

        // get all parcel 
        app.get('/parcel', async (req, res) => {
            const email = req.query.email;
            const query = {}
            if (email) {
                query.SenderEmail = email
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
            newParcel.CreatedAt = new Date();
            const result = await parcelsColl.insertOne(newParcel)
            res.send(result)
        })

        //delete a parcel
        app.delete('/parcel/:id', async (req, res) => {
            const id = req.params.id;
            const result = await parcelsColl.deleteOne({ _id: new ObjectId(id) })
            res.send(result)
        })

        // payment related apis here
        app.post('/payment-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.Cost) * 100;
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
                    parcelName: paymentInfo.ParcelName
                },
                mode: 'payment',
                customer_email: paymentInfo.SenderEmail,
                success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-canceld`,
            })
            res.send({ url: session.url })
        })

        // old 
        // app.post('/create-checkout-session', async (req, res) => {
        //     const paymentInfo = req.body;
        //     console.log(paymentInfo);
        //     const amount = parseInt(paymentInfo.Cost) * 100
        //     const session = await stripe.checkout.sessions.create({
        //         line_items: [
        //             {
        //                 price_data: {
        //                     currency: 'USD',
        //                     unit_amount: amount,
        //                     product_data: {
        //                         name: paymentInfo.ParcelName
        //                     }
        //                 },
        //                 quantity: 1,
        //             },
        //         ],
        //         mode: 'payment',
        //         metadata: {
        //             parcelId: paymentInfo.parcelId
        //         },
        //         customer_email: paymentInfo.SenderEmail,
        //         success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success`,
        //         cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-canceld`,
        //     });
        //     console.log(session);
        //     res.send({ url: session.url })
        // })

        //verify payment success
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            const trackingId = generateTrackingId()

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
                        trackingId: trackingId,
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

        app.get('/payments', async (req, res) => {
            const { email } = req.query;
            const query = {}
            if (email) {
                query.customerEmail = email;
            }
            const result = await paymentCollection.find(query).toArray();
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

