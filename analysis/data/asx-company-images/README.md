# asx-company-images

## steps

1. search for a company from the csx list located [here](ASXListedCompanies.csv)
  * combine search with terms like 'asx', 'australia', 'company logo' , 'png'
2. download the best matching logo for the company and store in folder mapping to the company logo i.e companies/<company-code>/logo.png
3. create a metadata json document with the following structure:
```json
{
  "code": "ABC",
  "url": "https://abc.lol.com.au/logo.png"
}
```
where the url is where the image was fetched from.
An example of this basic layout can be found here [companies/ABC/](companies/ABC/)

4. once finished with a batch of companies has been saved run the following commands:

```bash
git add . --all
git commit -am "added companies"
git push -u origin master
```
