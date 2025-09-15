const nodemailer = require("nodemailer");

const feedback = process.env.REVIEW_FEEDBACK || "No feedback";

const transporter = nodemailer.createTransport({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: {
        user: "your-email@example.com",
        pass: "your-email-password",
    },
});

transporter.sendMail({
    from: '"Code Review Bot" <your-email@example.com>',
    to: "your-email@example.com",
    subject: "New AI Code Review Feedback",
    text: feedback,
}).then(() => console.log("Email sent")).catch(console.error);
