# Classone-Discovery on Oracle Cloud's free tier ($0)

This covers one Arm VM with 2 OCPUs and 12 GB of RAM, on an account upgraded to pay-as-you-go so
the VM isn't reclaimed when it's idle. Inside the Always Free limits nothing is charged. After the
Oracle-specific steps below, the deployment itself is the same as in [DEPLOYMENT.md](DEPLOYMENT.md).

Links:
- Sign up: https://signup.cloud.oracle.com/
- Console: https://cloud.oracle.com/
- Free tier overview: https://www.oracle.com/cloud/free/
- Always Free limits: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Free tier and upgrading: https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm
- Budgets: https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm
- Creating an instance: https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm
- Security lists (firewall): https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm

## 1. Create the account
1. Open https://signup.cloud.oracle.com/ and use the company email if the account should belong to the company.
2. **Home region:** choose **India West (Mumbai)** or **India South (Hyderabad)**. You can't change this later, and free VMs can only be created in the home region.
3. Verify a card. Oracle makes a small refundable hold. Credit cards work most reliably; some Indian debit cards are rejected.

## 2. Upgrade to pay-as-you-go
Free-only accounts lose VMs that sit idle for 7 days. Ours will, because pipelines only run when someone starts them.
1. In the Console, click **Upgrade** in the top banner, or go to **Billing & Cost Management → Upgrade and Manage Payment**.
2. Choose **Pay As You Go** and confirm the card. Processing can take from a few minutes to a day.
3. Always Free resources stay free afterwards. Only usage above the limits is billed.

## 3. Set a spending alarm
1. Go to **Billing & Cost Management → Budgets → Create Budget**.
2. Target: the root compartment. Schedule: monthly. Amount: ₹100.
3. Alert rule: actual spend, threshold **1%** (₹1), and your email.
4. If any charge ever starts, you'll get an email within a day.

## 4. Make an SSH key (on your PC, PowerShell)
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_classone
Get-Content $HOME\.ssh\oracle_classone.pub     # copy this line
```

## 5. Create the VM
Go to **Compute → Instances → Create instance**.
- **Name:** `classone`
- **Image:** **Change image → Ubuntu → Canonical Ubuntu 24.04**. Use the normal image, not "Minimal".
- **Shape:** **Change shape → Virtual machine → Ampere → VM.Standard.A1.Flex**, set to **2 OCPUs, 12 GB**. It should show the "Always Free-eligible" label.
- **Networking:** create a new virtual cloud network with a **public subnet**, and keep **Assign a public IPv4 address** on.
- **SSH keys:** **Paste public keys**, then paste the line from step 4.
- **Boot volume:** the default 50 GB is enough. Up to 200 GB in total is free.
- **Create.** Note the **public IP** once it's running.

> **"Out of capacity for shape VM.Standard.A1.Flex"** means Oracle has no free Arm capacity in the region right now. Retry later; early mornings IST often work. Pay-as-you-go accounts get capacity more easily. If it keeps failing for days, use DigitalOcean or Lightsail instead (DEPLOYMENT.md).

The public IP stays the same until the VM is terminated. A reboot or stop/start doesn't change it.

## 6. Open the website ports
Go to **Networking → Virtual cloud networks → (your VCN) → Security → Default Security List → Add Ingress Rules**, and add two rules:
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **80**
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **443**

(The VM's own firewall is opened by `setup.sh`.)

## 7. Test whether the IIT sites let Oracle's IP in. Do this before anything else.
```powershell
scp -i $HOME\.ssh\oracle_classone deploy\probe-ip.sh ubuntu@<ip>:~
ssh -i $HOME\.ssh\oracle_classone ubuntu@<ip> "bash probe-ip.sh"
```
- **Mostly `ok`:** carry on.
- **Most faculty pages or Vidwan show `BLOCKED`:** Oracle's IPs won't do for those sources. Decide whether ORCID and OpenAlex alone are enough before you go further.

## 8. Deploy
On your PC, in the repo (the local `.env` must be working for the export):
```powershell
powershell -File deploy\pack.ps1
npm --prefix backend run db:export -- ..\classone-db.ndjson.gz
scp -i $HOME\.ssh\oracle_classone classone-app.tar.gz classone-db.ndjson.gz ubuntu@<ip>:~
ssh -i $HOME\.ssh\oracle_classone ubuntu@<ip>
```
On the server:
```bash
mkdir -p ~/classone && tar -xzf classone-app.tar.gz -C ~/classone
sudo BASIC_AUTH_USER=classone BASIC_AUTH_PASSWORD='choose-one' bash ~/classone/deploy/setup.sh
sudo nano /opt/classone/app/.env          # paste JEV_API_KEY / OPENAI_API_KEY / OPENALEX_API_KEY
sudo systemctl restart classone-backend
cd /opt/classone/app/backend && sudo npm run db:import -- ~/classone-db.ndjson.gz
```
Open the address the script prints (`https://<ip-with-dashes>.sslip.io`) and sign in with the shared login.

## Staying at $0
- Keep the Arm VMs at **2 OCPUs and 12 GB in total**, and boot plus block volumes at **200 GB in total**.
- Don't create anything the Console doesn't label "Always Free-eligible". That includes other shapes, extra load balancers, paid databases and resources outside the home region.
- Once a month, check **Billing & Cost Management → Cost Analysis**. It should read ₹0.
- Download a backup now and then. `/var/backups/classone` sits on the same VM, and a terminated account takes it with it:
  `scp -i $HOME\.ssh\oracle_classone ubuntu@<ip>:/var/backups/classone/classone-<date>.archive.gz .`
